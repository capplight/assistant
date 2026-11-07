import { create } from 'zustand';

/** «Уже было — добавил к записи от {дата} · Отменить» (F-10). One strip at a time. */
export type MergeStrip = { id: number; recordId: string; canonicalDate: string };

/** How long the strip stays on screen (4.10: 10 s). */
export const UNDO_STRIP_MS = 10_000;

let seq = 0;

type UndoState = {
  strip: MergeStrip | null;
  showMerged: (recordId: string, canonicalDate: string) => void;
  hide: (id?: number) => void;
};

export const useUndo = create<UndoState>()((set, get) => ({
  strip: null,
  showMerged: (recordId, canonicalDate) => set({ strip: { id: ++seq, recordId, canonicalDate } }),
  hide: (id) => {
    if (id === undefined || get().strip?.id === id) set({ strip: null });
  },
}));
