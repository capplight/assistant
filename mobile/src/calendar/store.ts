import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { CalendarEntryOut, TaskOccurrenceOut } from '@/api/types';
import { persistStorage } from '@/store/storage';

import type { CalView } from './nav';

/**
 * Ф-89 calendar state. Persisted: the last view of «Дела» (§2 «экран запоминает последний вид») and the person's own
 * changes still in the outbox (they win over /sync until answered, like the ticks of «Дела»). In memory (from SQLite,
 * migration v13): occurrences of repeating to-dos and the kept server entries.
 */

/** A move / resize by hand not answered yet, by entry key. */
export type TimeEdit = { startMs: number; duration: number | null; clientId: string };
/** One occurrence done or skipped by hand not answered yet, by entry key. */
export type OccEdit = { done?: boolean; skipped?: boolean; clientId: string };

/** «Напомнить» changed by hand not answered yet, by task key: minutes before the start, null = no alert. */
export type RemindEdit = { offset: number | null; clientId: string };

/** The assistant made / moved a timed to-do: the calendar goes to its day and rings the block for 1.5 s (§5). */
export type CalFocus = { taskId: string; date: string; startMin: number | null; until: number; seq: number };

type State = {
  view: CalView;
  /** The day the calendar shows (null = today); not persisted: every open is today unless asked. */
  date: string | null;
  occurrences: Record<string, TaskOccurrenceOut>;
  server: Record<string, CalendarEntryOut>;
  timeEdits: Record<string, TimeEdit>;
  occEdits: Record<string, OccEdit>;
  /** «Это и следующие» deleted by hand, not answered yet: task id → the first occurrence that goes (ms). */
  seriesEnds: Record<string, { from: number; clientId: string }>;
  remindEdits: Record<string, RemindEdit>;
  focus: CalFocus | null;
  loaded: boolean;
  set: (p: Partial<Omit<State, 'set' | 'reset'>>) => void;
  reset: () => void;
};

const initial = {
  view: 'list' as CalView,
  date: null,
  occurrences: {},
  server: {},
  timeEdits: {},
  occEdits: {},
  seriesEnds: {},
  remindEdits: {},
  focus: null,
  loaded: false,
};

export const useCalendar = create<State>()(
  persist(
    (set) => ({
      ...initial,
      set: (p) => set(p),
      reset: () => set(initial),
    }),
    {
      name: 'calendar',
      storage: persistStorage,
      version: 1,
      partialize: ({ view, timeEdits, occEdits, seriesEnds, remindEdits }) => ({ view, timeEdits, occEdits, seriesEnds, remindEdits }),
    },
  ),
);

export const calState = () => useCalendar.getState();
