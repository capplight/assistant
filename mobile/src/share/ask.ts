import { create } from 'zustand';

import type { LocalRecord } from '@/db/records';

/**
 * Week 13: after «Поделиться» of one PDF or one picture, the app asks what it is (a receipt, a
 * statement, or just a file). The phone cannot tell a statement from a contract by itself, and it
 * never sends a file to be read as money without the person's word.
 */
export type ShareAsk = { recordId: string; pdf: boolean };

type State = { ask: ShareAsk | null; set: (a: ShareAsk | null) => void };

export const useShareAsk = create<State>()((set) => ({ ask: null, set: (ask) => set({ ask }) }));

/** One PDF or one image (not a voice, not text, not several files): worth the question. */
export function askFor(saved: readonly LocalRecord[]): ShareAsk | null {
  if (saved.length !== 1) return null;
  const r = saved[0]!;
  if (r.kind === 'pdf') return { recordId: r.id, pdf: true };
  if (r.kind === 'image' || r.kind === 'screenshot') return { recordId: r.id, pdf: false };
  return null;
}
