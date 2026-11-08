import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ActionOut, HabitOut, TaskOut } from '@/api/types';
import { persistStorage } from '@/store/storage';

/**
 * Week 9: rows with a box on «Дела» and «Покупки» (3-engineering 3.x `tasks`), and the actions
 * «Что я сделал» shows (S20, «Я сделал за вас» on «Сегодня»).
 * kv-store like the alarms: a few hundred rows. TODO: SQLite tables when lists grow.
 *
 * A tick is the person's own change and must work offline at once: it is written here first
 * (`ticks`) and wins over the server's copy until its outbox row has gone.
 */
/** `clientId`: the outbox row that carries it (only that row's answer settles it). */
export type Tick = { done: boolean; at: string; clientId?: string };

type State = {
  /** By server id, or `local:<client_id>` until POST /tasks answers. */
  tasks: Record<string, TaskOut>;
  /** Ticks not confirmed by the server yet, by the key above. */
  ticks: Record<string, Tick>;
  /** Local key → server id, so a tick queued before the answer finds its task. */
  aliases: Record<string, string>;
  /** Task id → the action that made it (its «Отменить»). */
  createdBy: Record<string, string>;
  /** By action id; 30 days are kept (actions.md «Sync»). */
  actions: Record<string, ActionOut>;
  /** Learned rules from /sync `habits` (S30 offline); exclusions come only from GET /habits. */
  habits: Record<string, HabitOut>;
  /** Missed fires the person already answered with «Перенести» (they leave «Сегодня»). */
  handledMissed: string[];
  set: (p: Partial<Omit<State, 'set' | 'reset'>>) => void;
  reset: () => void;
};

const initial = { tasks: {}, ticks: {}, aliases: {}, createdBy: {}, actions: {}, habits: {}, handledMissed: [] };

export const useTasks = create<State>()(
  persist(
    (set) => ({
      ...initial,
      set: (p) => set(p),
      reset: () => set(initial),
    }),
    {
      name: 'tasks',
      storage: persistStorage,
      version: 1,
      partialize: ({ set: _s, reset: _r, ...rest }) => rest,
    },
  ),
);

export const tasksState = () => useTasks.getState();

export const LOCAL_TASK = 'local:';
