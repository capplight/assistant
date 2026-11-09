import type { FireOut, ReminderOut } from '@/api/types';

/**
 * Week 11а «Ежедневник» (today.md «The planner on Дела»): the sheet of a day built on the phone from
 * what /sync brings, so it is the same offline. Pure.
 */

/** One occurrence at its hour. */
export type Slot = {
  /** The occurrence's main fire (`offset_min: 0`, `snooze_n: 0`). */
  key: string;
  at: number;
  title: string;
  level: 'alarm' | 'notification';
  reminderId: string;
  /** The page row with this time (`reminder.item_id`): drawn here, not among «Без времени». */
  itemId: string | null;
  missed: boolean;
  acked: boolean;
  /** «Отложено до HH:MM» (the newest snooze fire). */
  snoozedUntil: number | null;
};

type LocalState = { ackedAt?: number | string | null; snoozedUntil?: number | string | null };
type Src = { fires: Record<string, FireOut>; reminders: Record<string, ReminderOut>; local: Record<string, LocalState | undefined> };

const live = (r: ReminderOut | undefined): r is ReminderOut =>
  !!r && r.kind === 'normal' && !r.deleted_at && r.status !== 'cancelled';

const ms = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

/** Occurrences in [from, to), by time. `missed`: keys of the missed rows (`missedRows`). */
export function sheetSlots(src: Src, missed: Set<string>, from: number, to: number): Slot[] {
  const byOcc = new Map<string, FireOut[]>();
  for (const f of Object.values(src.fires)) {
    const k = `${f.reminder_id}|${f.occurrence_at}`;
    byOcc.set(k, [...(byOcc.get(k) ?? []), f]);
  }
  const out: Slot[] = [];
  for (const fires of byOcc.values()) {
    const main = fires.find((f) => f.offset_min === 0 && f.snooze_n === 0);
    if (!main || main.state === 'cancelled') continue;
    const r = src.reminders[main.reminder_id];
    if (!live(r)) continue;
    const at = Date.parse(main.occurrence_at);
    if (!Number.isFinite(at) || at < from || at >= to) continue;
    const acked = fires.some((f) => f.state === 'acked' || !!src.local[f.key]?.ackedAt);
    const snoozes = fires.filter((f) => f.snooze_n > 0 && f.state !== 'cancelled').sort((a, b) => b.snooze_n - a.snooze_n);
    const snoozedUntil = acked ? null : (ms(snoozes[0]?.fire_at) ?? ms(src.local[main.key]?.snoozedUntil));
    out.push({
      key: main.key,
      at,
      title: r.title,
      level: r.level === 'alarm' ? 'alarm' : 'notification',
      reminderId: r.id,
      itemId: r.item_id,
      missed: !acked && missed.has(main.key),
      acked,
      snoozedUntil,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Records with a live reminder: their rows have a time (no «Выше / Ниже», not «Без времени»). */
export function timedItemIds(reminders: Record<string, ReminderOut>): Set<string> {
  const out = new Set<string>();
  for (const r of Object.values(reminders)) if (live(r) && r.item_id) out.add(r.item_id);
  return out;
}

/** Where «Сейчас» goes among the hours of today: before the first one still ahead. */
export const nowIndex = (slots: Slot[], now: number) => {
  const i = slots.findIndex((s) => s.at > now);
  return i < 0 ? slots.length : i;
};
