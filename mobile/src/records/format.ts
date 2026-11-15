import type { LocalRecord } from '@/db/records';

type T = (key: string, o?: Record<string, unknown>) => string;

/** «сегодня», «вчера» or «12 марта», in the app language. */
export function formatDay(iso: string, lang: string, t: T, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return t('record.today');
  if (days === 1) return t('record.yesterday');
  try {
    return d.toLocaleDateString(lang, { day: 'numeric', month: 'long' });
  } catch {
    return d.toDateString();
  }
}

/** «12 мар» for the strip «Уже было — добавил к записи от …». */
export function formatShortDate(iso: string, lang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleDateString(lang, { day: 'numeric', month: 'short' });
  } catch {
    return d.toDateString();
  }
}

/** The name of what has no text yet (a recording or a file not read so far). */
function kindLabel(rec: LocalRecord, t: T): string {
  switch (rec.kind) {
    case 'voice':
      return t('record.voice');
    case 'image':
    case 'screenshot':
      return t('record.photo');
    case 'link':
      return t('record.link');
    default:
      return rec.files[0]?.name ?? t('record.file');
  }
}

/** The line the person recognizes the record by. */
export function recordTitle(rec: LocalRecord, t: T): string {
  return rec.title || rec.summary || rec.text || rec.url || kindLabel(rec, t);
}

/** Where it came from: «из голосового, сегодня». */
export function sourceLine(rec: LocalRecord, lang: string, t: T): string {
  const date = formatDay(rec.occurredAt, lang, t);
  if (rec.kind === 'voice') return t('record.source_voice', { date });
  if (rec.kind === 'image' || rec.kind === 'screenshot') return t('record.source_photo', { date });
  if (rec.kind === 'link') return t('record.source_link', { date });
  if (rec.files.length > 0 || rec.kind !== 'note') return t('record.source_file', { date });
  if (rec.source === 'share') return t('record.source_share', { date });
  // QA v2 §2.4: what the person wrote shows just its date («вчера»), no «вы написали».
  return date;
}

/** A reading (voice, photo, file) with no answer for this long is told as not done (QA v2 §2.2). */
export const READING_TIMEOUT_MS = 60_000;

/** What is happening with the record, when there is something to say. */
export function statusLine(rec: LocalRecord, t: T, now: number = Date.now()): string | null {
  switch (rec.status) {
    case 'queued':
      return t('queue');
    case 'pending':
    case 'processing':
      // Plain text needs no reading; only say this about what has to be read first. A reading that hangs for a
      // minute is told plainly, with the record still there to open (the server times the job out too).
      if (rec.text) return null;
      return now - rec.createdAt > READING_TIMEOUT_MS ? t('record.processing_stuck') : t('record.processing');
    case 'needs_consent':
      return t('record.needs_consent');
    case 'failed':
      return t('record.failed');
    default:
      return null;
  }
}
