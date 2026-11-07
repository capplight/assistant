import { create } from 'zustand';

/** Bumped whenever local records or pages change: lists reload from SQLite. */
export const useDataVersion = create<{ version: number; bump: () => void }>()((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
