import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistStorage } from './storage';

/** «Заметки»: grid (masonry) or list — a per-phone preference (design-system v2 StickyNote, the header toggle). */
export type NotesLook = 'grid' | 'list';

export const useNotesLook = create<{ look: NotesLook; set: (l: NotesLook) => void }>()(
  persist(
    (set) => ({
      look: 'grid',
      set: (look) => set({ look }),
    }),
    { name: 'notes-look.v1', storage: persistStorage, partialize: (s) => ({ look: s.look }) },
  ),
);
