import type { CalendarEntryOut, TaskOccurrenceOut } from '@/api/types';

import type { SqlDb } from './outbox';

/**
 * Ф-89 calendar on this phone (local migration v13): occurrences of repeating to-dos from /sync `task_occurrences`
 * (tombstones `task_occurrence`) and the last GET /v1/calendar of a range (plan steps the phone cannot count itself).
 */
export interface CalendarRepository {
  putOccurrences(list: TaskOccurrenceOut[]): Promise<void>;
  removeOccurrence(id: string): Promise<void>;
  listOccurrences(): Promise<TaskOccurrenceOut[]>;
  /** The server's entries of [from, to] replace what was kept for those dates. */
  putRange(from: string, to: string, entries: CalendarEntryOut[], at: number): Promise<void>;
  /** Kept entries of [from, to]; with `before`, also drops what is older than that date (±60 days). */
  listRange(from: string, to: string): Promise<CalendarEntryOut[]>;
  prune(before: string, after: string): Promise<void>;
  wipe(): Promise<void>;
}

type OccRow = {
  id: string;
  task_id: string;
  occurrence_at: string;
  start_at: string | null;
  duration_min: number | null;
  done_at: string | null;
  skipped: number;
  version: number;
  seq: number;
  updated_at: string;
};

const fromOcc = (r: OccRow): TaskOccurrenceOut => ({
  id: r.id,
  task_id: r.task_id,
  occurrence_at: r.occurrence_at,
  start_at: r.start_at,
  duration_min: r.duration_min,
  done_at: r.done_at,
  skipped: !!r.skipped,
  version: r.version,
  seq: r.seq,
  updated_at: r.updated_at,
});

export class SqliteCalendarRepository implements CalendarRepository {
  constructor(private readonly db: SqlDb) {}

  async putOccurrences(list: TaskOccurrenceOut[]) {
    for (const o of list) {
      const prev = await this.db.getFirstAsync<{ seq: number }>('SELECT seq FROM task_occurrences WHERE id = ?', o.id);
      if (prev && prev.seq > o.seq) continue;
      await this.db.runAsync(
        `INSERT OR REPLACE INTO task_occurrences
           (id, task_id, occurrence_at, start_at, duration_min, done_at, skipped, version, seq, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        o.id,
        o.task_id,
        o.occurrence_at,
        o.start_at,
        o.duration_min,
        o.done_at,
        o.skipped ? 1 : 0,
        o.version,
        o.seq,
        o.updated_at,
      );
    }
  }

  async removeOccurrence(id: string) {
    await this.db.runAsync('DELETE FROM task_occurrences WHERE id = ?', id);
  }

  async listOccurrences() {
    return (await this.db.getAllAsync<OccRow>('SELECT * FROM task_occurrences')).map(fromOcc);
  }

  async putRange(from: string, to: string, entries: CalendarEntryOut[], at: number) {
    await this.db.runAsync('DELETE FROM calendar_entries WHERE date >= ? AND date <= ?', from, to);
    for (const e of entries) {
      await this.db.runAsync(
        'INSERT OR REPLACE INTO calendar_entries (key, date, json, fetched_at) VALUES (?, ?, ?, ?)',
        e.key,
        e.date,
        JSON.stringify(e),
        at,
      );
    }
  }

  async listRange(from: string, to: string) {
    const rows = await this.db.getAllAsync<{ json: string }>(
      'SELECT json FROM calendar_entries WHERE date >= ? AND date <= ? ORDER BY date',
      from,
      to,
    );
    const out: CalendarEntryOut[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.json) as CalendarEntryOut);
      } catch {
        // a broken row is only a cache: the next fetch replaces it
      }
    }
    return out;
  }

  async prune(before: string, after: string) {
    await this.db.runAsync('DELETE FROM calendar_entries WHERE date < ? OR date > ?', before, after);
  }

  async wipe() {
    await this.db.execAsync('DELETE FROM task_occurrences; DELETE FROM calendar_entries;');
  }
}

export class InMemoryCalendarRepository implements CalendarRepository {
  private occ = new Map<string, TaskOccurrenceOut>();
  private entries = new Map<string, CalendarEntryOut>();

  async putOccurrences(list: TaskOccurrenceOut[]) {
    for (const o of list) {
      const prev = this.occ.get(o.id);
      if (!prev || prev.seq <= o.seq) this.occ.set(o.id, o);
    }
  }
  async removeOccurrence(id: string) {
    this.occ.delete(id);
  }
  async listOccurrences() {
    return [...this.occ.values()];
  }
  async putRange(from: string, to: string, entries: CalendarEntryOut[]) {
    for (const [k, e] of this.entries) if (e.date >= from && e.date <= to) this.entries.delete(k);
    for (const e of entries) this.entries.set(e.key, e);
  }
  async listRange(from: string, to: string) {
    return [...this.entries.values()].filter((e) => e.date >= from && e.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  }
  async prune(before: string, after: string) {
    for (const [k, e] of this.entries) if (e.date < before || e.date > after) this.entries.delete(k);
  }
  async wipe() {
    this.occ.clear();
    this.entries.clear();
  }
}
