import type { ActionOut, TouchedKey } from '@/api/types';
import { refreshCachedRange } from '@/calendar/service';
import { pullBudget } from '@/expenses/budget';
import { syncBlocked } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { tasksState } from '@/tasks/store';
import { refreshToday, useToday } from '@/today/service';

/**
 * Ф-95 (actions.md «touched»): after the assistant (or an undo) changed something, every screen it touched updates by
 * itself. Records, pages, to-dos, reminders, expenses and plans come through /v1/sync (the callers already kick it);
 * this refetches what does not: `calendar` → GET /v1/calendar of the cached range, `budget` → GET /v1/expenses/budget,
 * `today` → GET /v1/today. An action without `touched` (an older server) changes nothing here: the old behaviour.
 *
 * Several actions of one phrase (or one /sync page) come close together: they are gathered for a moment and each
 * store is asked once. Every refetch keeps what is on screen until its answer replaces it (no empty flash, QA-3).
 */
export const touchedTiming = { debounceMs: 150 };

/** The keys refetched here; the rest come with /v1/sync. */
const REFETCHED: TouchedKey[] = ['calendar', 'budget', 'today'];

let pending = new Set<TouchedKey>();
let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> = Promise.resolve();

/** What these actions touched (null: none of them says — an older server). */
export function touchedOf(actions: readonly (ActionOut | null | undefined)[]): Set<TouchedKey> | null {
  let any = false;
  const out = new Set<TouchedKey>();
  for (const a of actions) {
    if (!a?.touched) continue;
    any = true;
    for (const k of a.touched) out.add(k);
  }
  return any ? out : null;
}

/** Refetch what these actions touched (soon, once per store). */
export function refreshTouched(actions: readonly (ActionOut | null | undefined)[]): void {
  const keys = touchedOf(actions);
  if (!keys) return;
  let added = false;
  for (const k of REFETCHED)
    if (keys.has(k)) {
      pending.add(k);
      added = true;
    }
  if (!added) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushTouched(), touchedTiming.debounceMs);
}

/**
 * /v1/sync and outbox answers bring actions the phone may know already (the chat's own, a repeat): only the new ones
 * and the ones that changed since (undone, a newer `seq`) refetch. Call BEFORE they are remembered.
 */
export function freshActions(list: readonly ActionOut[]): ActionOut[] {
  const known = tasksState().actions;
  return list.filter((a) => {
    const prev = known[a.id];
    return !prev || (prev.seq ?? 0) < (a.seq ?? 0) || !!prev.undone_at !== !!a.undone_at;
  });
}

/** Run what is gathered now (tests call it instead of waiting). */
export function flushTouched(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const keys = pending;
  pending = new Set();
  if (keys.size === 0) return running;
  running = running.then(() => run(keys)).catch(() => undefined);
  return running;
}

async function run(keys: Set<TouchedKey>): Promise<void> {
  if (useOnboarding.getState().consent === null || syncBlocked()) return;
  const jobs: Promise<void>[] = [];
  if (keys.has('calendar')) jobs.push(refreshCachedRange());
  if (keys.has('budget')) jobs.push(pullBudget());
  // «Сегодня» not loaded yet asks by itself when shown (its GET also runs the suggestion engine).
  if (keys.has('today') && useToday.getState().last !== null) jobs.push(refreshToday());
  await Promise.all(jobs.map((j) => j.catch(() => undefined)));
}

/** Test hook. */
export function resetTouchedForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = new Set();
  running = Promise.resolve();
}
