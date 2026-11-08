import type { FireOut, ReminderOut } from '@/api/types';

import { REPEAT_MINUTES, snoozeIds, type AlarmCapabilities, type AlarmSpec, type Backend } from './port';

/**
 * Fires → the rings this phone plans (docs/api/reminders.md, 3-engineering 6.6). Pure, so the
 * rules are tested without a phone:
 * - a fire that is `acked` / `missed` / `cancelled` (or answered here) does not ring;
 * - how it rings: «Будильник» when the reminder is `alarm` and this is the phone it rings on
 *   (`target_device_id` empty or ours, R-13), else a plain notification;
 * - a «Будильник» rings again at +5, +10, +15 min (the phone makes the repeats); an «Уведомление» once;
 * - «Отложить» here: the group rings again from the time chosen, until the server's new fire for it
 *   arrives (then that one, at the time the person chose — the server always says +10 min);
 * - iOS keeps at most 48 (of 64 system notifications); Android 200.
 */

/** What this phone did with a fire before the server knows (`key` → state). */
export type LocalFireState = { ackedAt?: number; snoozedUntil?: number; firedAt?: number };

export type PlanInput = {
  reminders: Record<string, ReminderOut>;
  fires: Record<string, FireOut>;
  local: Record<string, LocalFireState>;
  deviceId: string | null;
  now: number;
  backend: Backend;
};

const MIN = 60_000;
const ms = (iso: string) => Date.parse(iso);

export function maxPlanned(backend: Backend): number {
  return backend === 'android' ? 200 : 48;
}

/** The same occurrence and offset, one «Отложить» later. */
function successorOf(f: FireOut, all: FireOut[]): FireOut | null {
  return (
    all
      .filter(
        (g) =>
          g.reminder_id === f.reminder_id &&
          g.occurrence_at === f.occurrence_at &&
          g.offset_min === f.offset_min &&
          g.snooze_n > f.snooze_n,
      )
      .sort((a, b) => a.snooze_n - b.snooze_n)[0] ?? null
  );
}

function predecessorOf(f: FireOut, all: FireOut[]): FireOut | null {
  if (f.snooze_n === 0) return null;
  return (
    all.find(
      (g) =>
        g.reminder_id === f.reminder_id &&
        g.occurrence_at === f.occurrence_at &&
        g.offset_min === f.offset_min &&
        g.snooze_n === f.snooze_n - 1,
    ) ?? null
  );
}

export function levelFor(r: ReminderOut, f: FireOut, deviceId: string | null): 'alarm' | 'notification' {
  if (r.level !== 'alarm') return 'notification';
  return !f.target_device_id || (deviceId !== null && f.target_device_id === deviceId) ? 'alarm' : 'notification';
}

/** Is this fire still waiting for an answer here? */
export function isOpen(f: FireOut, r: ReminderOut | undefined, local: LocalFireState | undefined): boolean {
  if (!r || r.deleted_at || r.status === 'cancelled') return false;
  if (f.state === 'acked' || f.state === 'missed' || f.state === 'cancelled') return false;
  return !local?.ackedAt;
}

export function planAlarms(p: PlanInput): AlarmSpec[] {
  const all = Object.values(p.fires);
  const out: AlarmSpec[] = [];
  for (const f of all) {
    const r = p.reminders[f.reminder_id];
    const local = p.local[f.key];
    if (!r || !isOpen(f, r, local)) continue;
    const next = successorOf(f, all);
    // Snoozed: the next fire rings (once it is known); until then this one at the chosen time.
    if (f.state === 'snoozed' && next) continue;
    if (local?.snoozedUntil && next) continue;
    const level = levelFor(r, f, p.deviceId);
    let base = ms(f.fire_at);
    let ids: string[];
    const count = level === 'alarm' ? REPEAT_MINUTES.length : 0;
    if (local?.snoozedUntil) {
      base = local.snoozedUntil;
      ids = snoozeIds(f.key, base, count);
    } else {
      // The person chose another time than the server's +10 min («Другое время»): keep theirs.
      const prev = predecessorOf(f, all);
      const chosen = prev ? p.local[prev.key]?.snoozedUntil : undefined;
      if (chosen && Math.abs(chosen - base) > MIN) base = chosen;
      ids = Array.from({ length: count + 1 }, (_, n) => `${f.key}~${n}`);
    }
    if (f.state === 'snoozed' && !local?.snoozedUntil && r.snooze_until) base = ms(r.snooze_until);
    ids.forEach((id, n) => {
      const at = base + (n === 0 ? 0 : REPEAT_MINUTES[n - 1]! * MIN);
      if (at <= p.now) return;
      out.push({ id, group: f.key, fireAt: at, title: r.title, level, repeatN: n, kind: r.kind, dueAt: base });
    });
  }
  return out.sort((a, b) => a.fireAt - b.fireAt).slice(0, maxPlanned(p.backend));
}

/** The next ring of each open fire in the next `withinMs` (for «Сегодня» and S12), soonest first. */
export function upcoming(p: Omit<PlanInput, 'backend'>, withinMs: number) {
  const seen = new Set<string>();
  return planAlarms({ ...p, backend: 'android' })
    .filter((s) => s.kind === 'normal' && s.fireAt - p.now <= withinMs)
    .filter((s) => (seen.has(s.group) ? false : (seen.add(s.group), true)));
}

/** «Может опоздать до 10 минут» (rem.late_risk): Android without exact alarms. */
export function lateRisk(c: AlarmCapabilities | null): boolean {
  return c?.backend === 'android' && c.exactAlarms === false;
}
