import { create } from 'zustand';

/** Short confirmation («Сохранено ✓», 1 s — 2-design S22). One at a time; a new one replaces the old. */
export type Toast = { id: number; text: string; durationMs: number };

type ToastState = {
  toast: Toast | null;
  show: (text: string, durationMs?: number) => void;
  hide: (id?: number) => void;
};

let seq = 0;

export const useToast = create<ToastState>()((set, get) => ({
  toast: null,
  show: (text, durationMs = 1000) => set({ toast: { id: ++seq, text, durationMs } }),
  hide: (id) => {
    if (id === undefined || get().toast?.id === id) set({ toast: null });
  },
}));
