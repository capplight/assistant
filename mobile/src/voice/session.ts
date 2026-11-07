/**
 * Voice recording in fragments (3-engineering §2.1): AAC-LC mono 16 kHz ~24 kbps; a fragment is at most
 * 3 min, then a new one starts automatically; one recording ≤10 min. No live transcription (R-17).
 * Pure logic over a minimal recorder interface → unit-testable without native audio.
 */

export const FRAGMENT_MAX_MS = 3 * 60_000;
export const RECORDING_MAX_MS = 10 * 60_000;

/** What the session needs from expo-audio's AudioRecorder. */
export interface FragmentRecorder {
  /** Prepare a new file and start capturing. */
  begin(): Promise<void>;
  /** Stop and return the file URI of the fragment just recorded. */
  end(): Promise<string | null>;
}

export type Fragment = { uri: string; durationMs: number };

export type TickResult = 'recording' | 'rotated' | 'limit';

export type SessionState = 'idle' | 'recording' | 'busy' | 'done';

export class VoiceSession {
  state: SessionState = 'idle';
  readonly fragments: Fragment[] = [];
  private fragmentStart = 0;
  private readonly fragmentMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;
  /** start / rotation / finish / cancel run one after another (e.g. «Готово» pressed while starting). */
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  constructor(
    private readonly rec: FragmentRecorder,
    o: { fragmentMs?: number; maxMs?: number; now?: () => number } = {},
  ) {
    this.fragmentMs = o.fragmentMs ?? FRAGMENT_MAX_MS;
    this.maxMs = o.maxMs ?? RECORDING_MAX_MS;
    this.now = o.now ?? Date.now;
  }

  private recordedMs(): number {
    return this.fragments.reduce((s, f) => s + f.durationMs, 0);
  }

  /** Total recorded time including the running fragment (for the «Слушаю… 0:12» timer). */
  elapsedMs(): number {
    const running = this.state === 'recording' ? this.now() - this.fragmentStart : 0;
    return this.recordedMs() + running;
  }

  start(): Promise<void> {
    return this.serial(async () => {
      if (this.state !== 'idle') return;
      this.state = 'busy';
      await this.rec.begin();
      this.fragmentStart = this.now();
      this.state = 'recording';
    });
  }

  /** Close the running fragment and keep it. */
  private async closeFragment(): Promise<void> {
    const durationMs = Math.min(this.now() - this.fragmentStart, this.fragmentMs);
    const uri = await this.rec.end();
    if (uri) this.fragments.push({ uri, durationMs });
  }

  /**
   * Call periodically (every ~250–500 ms). Rotates to a new fragment at 3 min;
   * at the 10-min limit stops — the caller then calls finish().
   */
  tick(): Promise<TickResult> {
    return this.serial(() => this.tickNow());
  }

  private async tickNow(): Promise<TickResult> {
    if (this.state !== 'recording') return 'recording';
    if (this.elapsedMs() >= this.maxMs) {
      this.state = 'busy';
      await this.closeFragment();
      this.state = 'done';
      return 'limit';
    }
    if (this.now() - this.fragmentStart >= this.fragmentMs) {
      this.state = 'busy';
      await this.closeFragment();
      await this.rec.begin();
      this.fragmentStart = this.now();
      this.state = 'recording';
      return 'rotated';
    }
    return 'recording';
  }

  /** «Готово»: stop and return all fragments in order. */
  finish(): Promise<Fragment[]> {
    return this.serial(async () => {
      if (this.state === 'recording') {
        this.state = 'busy';
        await this.closeFragment();
      }
      this.state = 'done';
      return [...this.fragments];
    });
  }

  /** «Отмена»: stop, nothing is saved. */
  cancel(): Promise<void> {
    return this.serial(async () => {
      if (this.state === 'recording') {
        this.state = 'busy';
        await this.rec.end();
      }
      this.fragments.length = 0;
      this.state = 'done';
    });
  }
}

/** expo-audio metering is dBFS (≈ -160…0). Map -60…0 dB → 0…1 for the level ring. */
export function levelFromMetering(db: number | undefined | null): number {
  if (db === undefined || db === null || !Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

/** 0:12, 2:05, 10:00 */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
