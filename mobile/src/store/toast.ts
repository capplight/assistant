import { create } from 'zustand';

/** Short confirmation («Сохранено ✓», 1 s — 2-design S22). One at a time; a new one replaces the old. */
export type Toast = { id: number; text: string; durationMs: number };

type ToastState = {
  toast: Toast | null;
  /** How many bottoms with an assistant capsule are mounted: the toast shows right above the capsule there. */
  anchors: number;
  anchor: () => () => void;
  show: (text: string, durationMs?: number) => void;
  hide: (id?: number) => void;
};

let seq = 0;

export const useToast = create<ToastState>()((set, get) => ({
  toast: null,
  anchors: 0,
  anchor: () => {
    set((s) => ({ anchors: s.anchors + 1 }));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set((s) => ({ anchors: Math.max(0, s.anchors - 1) }));
    };
  },
  show: (text, durationMs = 1000) => set({ toast: { id: ++seq, text, durationMs } }),
  hide: (id) => {
    if (id === undefined || get().toast?.id === id) set({ toast: null });
  },
}));
