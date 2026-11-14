import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistStorage } from './storage';

/**
 * «Бюджет на месяц» (design-system v2 «Расходы», Ф-55): one amount in tenge kept on this phone (minor units as a
 * string — bigint is not JSON). The server has no budget yet; until it is set nothing says «осталось в бюджете».
 */
export const useBudget = create<{ monthMinor: string | null; set: (minor: bigint | null) => void }>()(
  persist(
    (set) => ({
      monthMinor: null,
      set: (minor) => set({ monthMinor: minor && minor > 0n ? minor.toString() : null }),
    }),
    { name: 'budget.v1', storage: persistStorage, partialize: (s) => ({ monthMinor: s.monthMinor }) },
  ),
);

export const budgetMinor = (s: { monthMinor: string | null }): bigint | null => (s.monthMinor ? BigInt(s.monthMinor) : null);
