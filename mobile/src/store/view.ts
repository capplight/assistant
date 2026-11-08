import { create } from 'zustand';

/** Records on screen sent with a request from the line (docs/api/chat.md `visible_item_ids`, ≤40). */
export const MAX_VISIBLE_ITEMS = 40;

/** 2-design `motion.highlight`: what the assistant changed is marked this long. */
export const HIGHLIGHT_MS = 600;

/**
 * What the person is looking at right now — the page context of a request from the line
 * (3-engineering 4.12: `visible_item_ids`, `selected_item_id` for «это / здесь») — and the
 * page's own state while the assistant changes it: the finger on the list (nothing moves under it,
 * R-54), the rows to highlight, and «выбрать» (tap the record the question was about, US-30).
 * Not persisted: it is only about this moment.
 */
type ViewState = {
  /** Local page id → server ids of the rows on screen, top first. */
  visible: Record<string, string[]>;
  /** The open record card (server id): «это» = this record. */
  selected: string | null;
  /** A finger is on the page list (scrolling or holding). */
  touching: boolean;
  /** Server item ids marked `markerSoft` until `until` (ms). */
  highlight: { ids: string[]; until: number } | null;
  /** «Какую? → выбрать»: the next tap on a record answers the assistant. */
  picking: { messageId: string; pageId: string } | null;
  /** Week 9, a tip's [Да]: put a phrase in the line (the person sends it) or open the mic. */
  lineRequest: { id: number; kind: 'text'; text: string } | { id: number; kind: 'mic' } | null;
  requestLine: (r: { kind: 'text'; text: string } | { kind: 'mic' } | null) => void;
  setVisible: (pageId: string, ids: string[]) => void;
  setSelected: (id: string | null) => void;
  setTouching: (v: boolean) => void;
  showHighlight: (ids: string[], now?: number) => void;
  clearHighlight: () => void;
  setPicking: (p: ViewState['picking']) => void;
  reset: () => void;
};

const empty = { visible: {}, selected: null, touching: false, highlight: null, picking: null, lineRequest: null };
let lineSeq = 0;

export const useView = create<ViewState>()((set) => ({
  ...empty,
  setVisible: (pageId, ids) =>
    set((s) => {
      const next = ids.slice(0, MAX_VISIBLE_ITEMS);
      const old = s.visible[pageId];
      if (old && old.length === next.length && old.every((x, i) => x === next[i])) return s;
      return { visible: { ...s.visible, [pageId]: next } };
    }),
  setSelected: (selected) => set({ selected }),
  setTouching: (touching) => set({ touching }),
  showHighlight: (ids, now = Date.now()) => set({ highlight: ids.length > 0 ? { ids, until: now + HIGHLIGHT_MS } : null }),
  clearHighlight: () => set({ highlight: null }),
  setPicking: (picking) => set({ picking }),
  requestLine: (r) => set({ lineRequest: r ? { ...r, id: ++lineSeq } : null }),
  reset: () => set(empty),
}));
