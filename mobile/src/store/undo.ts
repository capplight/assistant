import { create } from 'zustand';

/**
 * «Уже было — добавил к записи от {дата} · Отменить» (F-10), «Удалил запись · Отменить».
 * One strip at a time.
 */
export type UndoStripState =
  | { id: number; kind: 'merged'; recordId: string; canonicalDate: string }
  | { id: number; kind: 'deleted'; recordId: string };

/** 2-design 4.3 fixes these: 10 s; 15 s with a font of 150% and more; 30 s with a screen reader. */
export const UNDO_STRIP_MS = 10_000;
export const UNDO_STRIP_LARGE_FONT_MS = 15_000;
export const UNDO_STRIP_SCREEN_READER_MS = 30_000;

export function undoStripMs(o: { largeFont: boolean; screenReader: boolean }): number {
  if (o.screenReader) return UNDO_STRIP_SCREEN_READER_MS;
  return o.largeFont ? UNDO_STRIP_LARGE_FONT_MS : UNDO_STRIP_MS;
}

let seq = 0;

type UndoState = {
  strip: UndoStripState | null;
  showMerged: (recordId: string, canonicalDate: string) => void;
  showDeleted: (recordId: string) => void;
  hide: (id?: number) => void;
};

export const useUndo = create<UndoState>()((set, get) => ({
  strip: null,
  showMerged: (recordId, canonicalDate) => set({ strip: { id: ++seq, kind: 'merged', recordId, canonicalDate } }),
  showDeleted: (recordId) => set({ strip: { id: ++seq, kind: 'deleted', recordId } }),
  hide: (id) => {
    if (id === undefined || get().strip?.id === id) set({ strip: null });
  },
}));
