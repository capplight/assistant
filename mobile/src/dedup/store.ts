import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { CollectionOut, DuplicateGroupOut, ImportOut, PendingActionOut } from '@/api/types';
import { persistStorage } from '@/store/storage';

/**
 * Week 10: what the phone keeps of repeats, stacks and imports, so «Заметки», «Ещё → Повторы»
 * and the import summary show offline too. kv-store like tasks: tens of rows, not thousands.
 */
export type ImportRow = {
  /** The `client_id` of the import (and of its upload): the outbox row carries it. */
  clientId: string;
  outboxId: string;
  fileName: string;
  /** Set once POST /imports/telegram/file answered. */
  importId: string | null;
  /** Refused for good before it started (`not_telegram_export`, `too_big`, …). */
  error: string | null;
  at: string;
};

type State = {
  /** `suggested` near groups by id («Объединить?»). */
  groups: Record<string, DuplicateGroupOut>;
  /** Groups decided on this phone: gone from the list at once, before the server says so. */
  decided: string[];
  /** The newest `cleanup_batch` waiting for «Да» («Убрать повторы: 37 → 1?»), or null. */
  cleanup: PendingActionOut | null;
  /** Stacks by id; a stack is a group on its page (`page_id`, rows with `group_key = title`). */
  collections: Record<string, CollectionOut>;
  /** Stacks taken apart here, until the server says so. */
  goneCollections: string[];
  imports: Record<string, ImportOut>;
  /** The last file the person chose on S21 (one at a time). */
  importRow: ImportRow | null;
  /** The `telegram_import` consent was given on this account (S21 asks once). */
  telegramConsent: boolean;
  set: (p: Partial<Omit<State, 'set' | 'reset'>>) => void;
  reset: () => void;
};

const initial = {
  groups: {},
  decided: [],
  cleanup: null,
  collections: {},
  goneCollections: [],
  imports: {},
  importRow: null,
  telegramConsent: false,
};

export const useDedup = create<State>()(
  persist(
    (set) => ({
      ...initial,
      set: (p) => set(p),
      reset: () => set(initial),
    }),
    {
      name: 'dedup',
      storage: persistStorage,
      version: 1,
      partialize: ({ set: _s, reset: _r, ...rest }) => rest,
    },
  ),
);

export const dedupState = () => useDedup.getState();
