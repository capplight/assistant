import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { getTemplate, MAX_PAGES, type IconKey, type Layout, type TemplateKey } from '@/pages/templates';
import { newId } from '@/utils/id';

import { persistStorage } from './storage';

/** 3-engineering §3.10 `screens.created_by`. */
export type PageCreatedBy = 'onboarding_gallery' | 'onboarding_blank' | 'onboarding_phrase' | 'user' | 'agent' | 'seed';

/** A user page = a view on shared memory (R-46). «Сегодня» is system and not stored here. */
export type Page = {
  id: string;
  templateKey: TemplateKey;
  /** null → localized template title (so RU/KK switch works); set for custom pages or renamed ones. */
  title: string | null;
  icon: IconKey;
  layout: Layout;
  /** Order in «Мои страницы» and tabs. TODO: LexoRank shared module (week 7). */
  position: number;
  createdBy: PageCreatedBy;
  createdAt: string;
};

function makePage(
  templateKey: TemplateKey,
  position: number,
  createdBy: PageCreatedBy,
  title: string | null = null,
): Page {
  const tpl = getTemplate(templateKey);
  return {
    id: newId(),
    templateKey,
    title,
    icon: tpl.icon,
    layout: tpl.defaultLayout,
    position,
    createdBy,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Placeholder seed (week-1 skeleton): Заметки / Дела и напоминания / Расходы.
 * Onboarding replaces it with the user's own choice (createFromOnboarding).
 */
export const SEED_TEMPLATES: readonly TemplateKey[] = ['notes', 'tasks', 'expenses'];
export function seedPages(): Page[] {
  return SEED_TEMPLATES.map((k, i) => makePage(k, i, 'seed'));
}

type PagesState = {
  pages: Page[];
  /** Replace pages with the onboarding choice; returns the created pages in order. */
  createFromOnboarding: (keys: TemplateKey[], createdBy: PageCreatedBy, customTitle?: string) => Page[];
  addPage: (key: TemplateKey, title?: string) => Page | null;
  reset: () => void;
};

export const usePages = create<PagesState>()(
  persist(
    (set, get) => ({
      pages: seedPages(),
      createFromOnboarding: (keys, createdBy, customTitle) => {
        const unique = keys.filter((k, i) => getTemplate(k).singleton === false || keys.indexOf(k) === i);
        const created = unique
          .slice(0, MAX_PAGES - 1)
          .map((k, i) => makePage(k, i, createdBy, k === 'custom' ? (customTitle ?? null) : null));
        set({ pages: created });
        return created;
      },
      addPage: (key, title) => {
        const { pages } = get();
        if (pages.length >= MAX_PAGES - 1) return null;
        if (getTemplate(key).singleton && pages.some((p) => p.templateKey === key)) return null;
        const page = makePage(key, pages.length, 'user', title ?? null);
        set({ pages: [...pages, page] });
        return page;
      },
      reset: () => set({ pages: seedPages() }),
    }),
    { name: 'pages.v1', storage: persistStorage, partialize: ({ pages }) => ({ pages }) },
  ),
);

export const selectSortedPages = (s: PagesState) => [...s.pages].sort((a, b) => a.position - b.position);
