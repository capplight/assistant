import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ExpenseCategoryOut, ExpenseOut } from '@/api/types';
import { persistStorage } from '@/store/storage';

/**
 * Week 12: «Расходы» on the phone (3-engineering 3.12, template-screens 2.2). The entries and the
 * categories as the server last said (/sync `expense_entries`, `expense_categories`), and the
 * person's own changes still on their way, which win over /sync until their outbox row is answered:
 * so the keypad, the totals and every change work at once, offline and in «Без ИИ».
 * kv-store like tasks: a family writes a few hundred spendings a month. TODO: SQLite tables when they grow.
 */

/** A change by hand not confirmed yet: the fields it sets (a deletion sets `deleted_at`). */
export type ExpenseEdit = { fields: Partial<ExpenseOut>; clientId: string };

/** The person's order of the chips, not confirmed yet. */
export type OrderEdit = { keys: string[]; clientId: string };

type State = {
  /** By server id, or `local:<client_id>` until POST /expenses answers. */
  entries: Record<string, ExpenseOut>;
  /** Local key → server id, so a change queued before the answer finds its entry. */
  aliases: Record<string, string>;
  edits: Record<string, ExpenseEdit>;
  /** By key; empty until the server answered once (the 8 defaults show meanwhile). */
  categories: Record<string, ExpenseCategoryOut>;
  orderEdit: OrderEdit | null;
  /** Entry id → the action that made it (its «Отменить» once sent). */
  createdBy: Record<string, string>;
  set: (p: Partial<Omit<State, 'set' | 'reset'>>) => void;
  reset: () => void;
};

const initial = { entries: {}, aliases: {}, edits: {}, categories: {}, orderEdit: null, createdBy: {} };

export const useExpenses = create<State>()(
  persist(
    (set) => ({
      ...initial,
      set: (p) => set(p),
      reset: () => set(initial),
    }),
    { name: 'expenses.v1', storage: persistStorage, version: 1, partialize: ({ set: _s, reset: _r, ...rest }) => rest },
  ),
);

export const expensesState = () => useExpenses.getState();

export const LOCAL_EXPENSE = 'local:';

/** The entry as the person sees it: their changes on the way on top of the server's copy. */
export function shownExpense(e: ExpenseOut, edits: Record<string, ExpenseEdit>): ExpenseOut {
  const edit = edits[e.id];
  return edit ? { ...e, ...edit.fields } : e;
}

