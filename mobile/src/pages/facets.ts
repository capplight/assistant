import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistStorage } from '@/store/storage';

/**
 * Values of fields that live on a page, not in the record (3-engineering 3.10 `item_facets`):
 * «Своя страница» own fields (a table cell) and its checklist tick (`done`). Kept on the phone so
 * they show offline at once; the outbox sends each change (`page.item_fields`).
 * Not yet read back from the server (no `/sync` array for them in the contract yet).
 */
export type FieldValue = string | number | boolean | null;

/** By local page id + local record id: a page or record not on the server yet works the same. */
export const facetKey = (pageId: string, recordId: string) => `${pageId}|${recordId}`;

/** The checklist tick of «Своя страница». */
export const DONE_FIELD = 'done';

type FacetsState = {
  values: Record<string, Record<string, FieldValue>>;
  set: (key: string, fields: Record<string, FieldValue>) => void;
  reset: () => void;
};

export const useFacets = create<FacetsState>()(
  persist(
    (set) => ({
      values: {},
      set: (key, fields) => set((s) => ({ values: { ...s.values, [key]: { ...s.values[key], ...fields } } })),
      reset: () => set({ values: {} }),
    }),
    { name: 'facets.v1', version: 1, storage: persistStorage, partialize: ({ values }) => ({ values }) },
  ),
);

/** «48 500» / «48 500,50» → tiyn (integer), or null. Sums of «Сумма ₸» are counted by code, never by the assistant. */
export function moneyToMinor(v: FieldValue): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  const s = String(v).replace(/[\s ₸]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const [int, frac = ''] = s.replace('-', '').split('.');
  const minor = Number(int) * 100 + Number((frac + '00').slice(0, 2));
  return s.startsWith('-') ? -minor : minor;
}

/** 5470000 → «54 700 ₸»; kopecks only when there are some. */
export function formatMoney(minor: number): string {
  const sign = minor < 0 ? '−' : '';
  const abs = Math.abs(minor);
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = abs % 100;
  return `${sign}${int}${frac ? `,${String(frac).padStart(2, '0')}` : ''} ₸`;
}
