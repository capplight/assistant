import { addDaysIso, addMonths } from './time';

/**
 * Ф-91 / calendar-time.md §2.1: ONE back control per screen (the «‹» in the sheet and the system back do the same):
 * from another day → the calendar on today (same view); from the calendar on today → the screen it came from. Picking
 * other days (a swipe, a day of the week, another view) never stacks steps: from any day «Сегодня» is ≤ 2 backs away.
 * Pure, for tests.
 */
export type CalView = 'list' | 'day' | 'multi' | 'month';

export type CalNav = { view: CalView; date: string };

export type BackStep = { kind: 'today'; nav: CalNav } | { kind: 'leave' };

export function backStep(nav: CalNav, today: string): BackStep {
  if (nav.view !== 'list' && nav.date !== today) return { kind: 'today', nav: { ...nav, date: today } };
  return { kind: 'leave' };
}

/** A swipe of the grid: the next day, the next 3 (or 7) days, the next month. Replaces the date, adds no step. */
export function pageStep(nav: CalNav, dir: -1 | 1, columns = 3): CalNav {
  if (nav.view === 'month') return { ...nav, date: addMonths(nav.date, dir) };
  if (nav.view === 'multi') return { ...nav, date: addDaysIso(nav.date, dir * columns) };
  return { ...nav, date: addDaysIso(nav.date, dir) };
}

/** Another view keeps the chosen day (also no step). */
export const switchView = (nav: CalNav, view: CalView): CalNav => ({ ...nav, view });
