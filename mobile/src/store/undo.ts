import { create } from 'zustand';

import type { Page } from './pages';

/** Week 7, by hand: what the strip says (i18n key) and the pages it names. */
export type ManualStripText = {
  key: 'move.reordered' | 'move.done' | 'move.also_done' | 'move.removed' | 'pages.moved' | 'pages.removed';
  pages?: Page[];
  /** From the server: «Похожие положу туда же» (only when it did learn, pages.md `learned_ru`). */
  extra?: string;
};

/**
 * «Уже было — добавил к записи от {дата} · Отменить» (F-10), «Удалил запись · Отменить».
 * One strip at a time.
 */
export type UndoStripState =
  | { id: number; kind: 'merged'; recordId: string; canonicalDate: string }
  | { id: number; kind: 'deleted'; recordId: string }
  /** «Разложил 23 заметки в 5 групп [Что изменилось] [Отменить]»: the action of this assistant message. */
  | { id: number; kind: 'action'; messageId: string }
  /** «Переставил · Отменить», «Перенёс в Расходы… [Открыть] [Отменить]»: the outbox rows of it. */
  | { id: number; kind: 'manual'; text: ManualStripText; outboxIds: string[]; openPageId: string | null }
  /** Week 9: a change of the phone's own (a box ticked, a row added, a rule taken off) with its undo. */
  | { id: number; kind: 'custom'; text: string; onUndo: () => void; openPageId: string | null };

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
  showAction: (messageId: string) => void;
  showManual: (text: ManualStripText, outboxIds: string[], openPageId?: string | null) => void;
  showCustom: (text: string, onUndo: () => void, openPageId?: string | null) => void;
  /** The strip of this outbox row, if still shown, gets the server's line; false when it is gone. */
  noteLearned: (outboxId: string, text: string) => boolean;
  hide: (id?: number) => void;
};

export const useUndo = create<UndoState>()((set, get) => ({
  strip: null,
  showMerged: (recordId, canonicalDate) => set({ strip: { id: ++seq, kind: 'merged', recordId, canonicalDate } }),
  showDeleted: (recordId) => set({ strip: { id: ++seq, kind: 'deleted', recordId } }),
  showAction: (messageId) => set({ strip: { id: ++seq, kind: 'action', messageId } }),
  showManual: (text, outboxIds, openPageId = null) =>
    set({ strip: { id: ++seq, kind: 'manual', text, outboxIds, openPageId } }),
  showCustom: (text, onUndo, openPageId = null) => set({ strip: { id: ++seq, kind: 'custom', text, onUndo, openPageId } }),
  noteLearned: (outboxId, extra) => {
    const s = get().strip;
    if (s?.kind !== 'manual' || !s.outboxIds.includes(outboxId)) return false;
    set({ strip: { ...s, text: { ...s.text, extra } } });
    return true;
  },
  hide: (id) => {
    if (id === undefined || get().strip?.id === id) set({ strip: null });
  },
}));
