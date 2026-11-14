import { create } from 'zustand';

import type { ReminderDraft } from '@/api/types';

/**
 * Ф-50 / design-system v2 ConfirmCard: a reminder read from the line or the voice shows as a card above the line
 * instead of the S13 form. One draft is saved at once (the card says «Будильник поставлен»); several readings
 * («в 7» — 7:00 or 19:00?) wait for a time chip. The manual «Новое напоминание» keeps the form.
 */
export type ReminderCard = {
  id: number;
  text: string;
  draft: ReminderDraft | null;
  options: ReminderDraft[];
  message: string | null;
  messageId: string | null;
  via: 'voice' | 'typed';
  /** The reminder saved from this card (local id), once saved. */
  savedId: string | null;
  /** When it was saved (ms), for the 5 s bar. */
  savedAt: number | null;
};

let seq = 0;

type State = {
  card: ReminderCard | null;
  show: (c: Omit<ReminderCard, 'id' | 'savedId' | 'savedAt'>) => void;
  saved: (id: string, at?: number) => void;
  close: () => void;
};

export const useReminderCard = create<State>()((set) => ({
  card: null,
  show: (c) => set({ card: { ...c, id: ++seq, savedId: null, savedAt: null } }),
  saved: (id, at = Date.now()) => set((s) => (s.card ? { card: { ...s.card, savedId: id, savedAt: at } } : s)),
  close: () => set({ card: null }),
}));
