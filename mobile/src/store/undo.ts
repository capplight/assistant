import { create } from 'zustand';

import type { ActionOut } from '@/api/types';

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
  /** «Удалено: «Шины» · Восстановить» (Ф-66): `what` names it when known. */
  | { id: number; kind: 'deleted'; recordId: string; what?: string }
  /** «Разложил 23 заметки в 5 групп [Что изменилось] [Отменить]»: the action of this assistant message. */
  | { id: number; kind: 'action'; messageId: string }
  /** «Переставил · Отменить», «Перенёс в Расходы… [Открыть] [Отменить]»: the outbox rows of it. */
  | { id: number; kind: 'manual'; text: ManualStripText; outboxIds: string[]; openPageId: string | null }
  /**
   * Ф-50 SaveToast for a record saved on this phone (offline, voice): «Сохранил в «Заметки»: …» · Переложить ·
   * Отменить (the record goes to the trash).
   */
  | { id: number; kind: 'saved'; recordId: string; pageId: string | null; what: string }
  /** Ф-69: an action the server made in the background («Разобрал: перенёс в «Расходы»»), from /v1/sync. */
  | { id: number; kind: 'server'; action: ActionOut }
  /** Week 9: a change of the phone's own (a box ticked, a row added, a rule taken off) with its undo. */
  | { id: number; kind: 'custom'; text: string; onUndo: () => void; openPageId: string | null };

/** The top notice (Ф-67, Ф-75): 3 s, the server's `notice.ms` when it sends one; a screen reader keeps it 30 s. */
export const NOTICE_MS = 3_000;

let seq = 0;

type UndoState = {
  strip: UndoStripState | null;
  showMerged: (recordId: string, canonicalDate: string) => void;
  showDeleted: (recordId: string, what?: string) => void;
  showAction: (messageId: string) => void;
  showManual: (text: ManualStripText, outboxIds: string[], openPageId?: string | null) => void;
  showCustom: (text: string, onUndo: () => void, openPageId?: string | null) => void;
  showSaved: (recordId: string, pageId: string | null, what: string) => void;
  showServer: (action: ActionOut) => void;
  /** The strip of this outbox row, if still shown, gets the server's line; false when it is gone. */
  noteLearned: (outboxId: string, text: string) => boolean;
  hide: (id?: number) => void;
};

export const useUndo = create<UndoState>()((set, get) => ({
  strip: null,
  showMerged: (recordId, canonicalDate) => set({ strip: { id: ++seq, kind: 'merged', recordId, canonicalDate } }),
  showDeleted: (recordId, what) => set({ strip: { id: ++seq, kind: 'deleted', recordId, what } }),
  showAction: (messageId) => set({ strip: { id: ++seq, kind: 'action', messageId } }),
  showManual: (text, outboxIds, openPageId = null) =>
    set({ strip: { id: ++seq, kind: 'manual', text, outboxIds, openPageId } }),
  showCustom: (text, onUndo, openPageId = null) => set({ strip: { id: ++seq, kind: 'custom', text, onUndo, openPageId } }),
  showSaved: (recordId, pageId, what) => set({ strip: { id: ++seq, kind: 'saved', recordId, pageId, what } }),
  showServer: (action) => set({ strip: { id: ++seq, kind: 'server', action } }),
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
