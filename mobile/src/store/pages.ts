import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { between, compareRank, sequence } from '@/pages/lexorank';
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
  /** The name in Kazakh, when a renamed page has one. */
  titleKk: string | null;
  icon: IconKey;
  layout: Layout;
  /** LexoRank: order in «Мои страницы» and tabs; compare by bytes, tie-break id. */
  position: string;
  createdBy: PageCreatedBy;
  createdAt: string;
  /** Server id; null until POST /pages answered. */
  serverId: string | null;
  /** `failed`: the server refused it for good; the page stays on this phone. */
  syncState: 'pending' | 'synced' | 'failed';
  seq: number;
  /** The server's `view_version` of what the phone shows (sent with a request from the line). */
  viewVersion?: number;
  /** Group headings after «Разложи» (`group_key` → title). */
  groups?: PageGroup[];
};

export type PageGroup = { key: string; title: string };

function makePage(
  templateKey: TemplateKey,
  position: string,
  createdBy: PageCreatedBy,
  title: string | null = null,
): Page {
  const tpl = getTemplate(templateKey);
  return {
    id: newId(),
    templateKey,
    title,
    titleKk: null,
    icon: tpl.icon,
    layout: tpl.defaultLayout,
    position,
    createdBy,
    createdAt: new Date().toISOString(),
    serverId: null,
    syncState: 'pending',
    seq: 0,
  };
}

/**
 * Placeholder seed (week-1 skeleton): Заметки / Дела и напоминания / Расходы.
 * Onboarding replaces it with the user's own choice (createFromOnboarding).
 */
export const SEED_TEMPLATES: readonly TemplateKey[] = ['notes', 'tasks', 'expenses'];
export function seedPages(): Page[] {
  const keys = sequence(SEED_TEMPLATES.length);
  return SEED_TEMPLATES.map((k, i) => makePage(k, keys[i] ?? 'V', 'seed'));
}

/** Tab order: `position` by bytes, tie-break id (docs/api/pages.md). */
export function comparePages(a: Page, b: Page): number {
  return compareRank(a.position, b.position) || (a.id < b.id ? -1 : 1);
}

/** Weeks 1-2 stored integer positions and no server fields. */
export function migrateV0(state: unknown): { pages: Page[] } {
  const old = (state as { pages?: (Omit<Page, 'position'> & { position: number })[] })?.pages ?? [];
  const sorted = [...old].sort((a, b) => a.position - b.position);
  const keys = sequence(sorted.length);
  return {
    pages: sorted.map((p, i) => ({
      ...p,
      position: keys[i] ?? 'V',
      titleKk: null,
      serverId: null,
      syncState: 'pending' as const,
      seq: 0,
    })),
  };
}

type PagesState = {
  pages: Page[];
  /** Replace pages with the onboarding choice; returns the created pages in order. */
  createFromOnboarding: (keys: TemplateKey[], createdBy: PageCreatedBy, customTitle?: string) => Page[];
  addPage: (key: TemplateKey, title?: string) => Page | null;
  renamePage: (id: string, title: string | null) => void;
  reset: () => void;
};

export const usePages = create<PagesState>()(
  persist(
    (set, get) => ({
      pages: seedPages(),
      createFromOnboarding: (keys, createdBy, customTitle) => {
        const unique = keys.filter((k, i) => getTemplate(k).singleton === false || keys.indexOf(k) === i);
        const chosen = unique.slice(0, MAX_PAGES - 1);
        const positions = sequence(chosen.length);
        const created = chosen.map((k, i) =>
          makePage(k, positions[i] ?? 'V', createdBy, k === 'custom' ? (customTitle ?? null) : null),
        );
        set({ pages: created });
        return created;
      },
      addPage: (key, title) => {
        const { pages } = get();
        if (pages.length >= MAX_PAGES - 1) return null;
        if (getTemplate(key).singleton && pages.some((p) => p.templateKey === key)) return null;
        const last = [...pages].sort(comparePages).at(-1);
        const page = makePage(key, between(last?.position ?? null, null), 'user', title ?? null);
        set({ pages: [...pages, page] });
        return page;
      },
      renamePage: (id, title) =>
        set({ pages: get().pages.map((p) => (p.id === id ? { ...p, title, titleKk: null } : p)) }),
      reset: () => set({ pages: seedPages() }),
    }),
    {
      name: 'pages.v1',
      version: 1,
      storage: persistStorage,
      partialize: ({ pages }) => ({ pages }),
      migrate: (state, version) => (version < 1 ? migrateV0(state) : state) as Pick<PagesState, 'pages'> as PagesState,
    },
  ),
);

export const selectSortedPages = (s: PagesState) => [...s.pages].sort(comparePages);
