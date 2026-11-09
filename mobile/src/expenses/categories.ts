import type { ExpenseCategoryOut, ExpenseOut } from '@/api/types';

import { addDays, TRANSFERS_KEY } from './calc';

/**
 * The 8 categories (template-screens 4, expenses.md «Categories»): all seen as chips at once, no
 * «Ещё». A local copy so the keypad works before the server answered once (the person's own rows
 * are made there on first use); the server's list (ids, own ones, the order) replaces it.
 * KK titles here are drafts. «Переводы» is a service category: never a chip, never in a total.
 */
export const SYSTEM_CATEGORIES: readonly { key: string; ru: string; kk: string }[] = [
  { key: 'groceries', ru: 'Продукты', kk: 'Азық-түлік' },
  { key: 'home', ru: 'Дом и ремонт', kk: 'Үй және жөндеу' },
  { key: 'transport', ru: 'Транспорт', kk: 'Көлік' },
  { key: 'health', ru: 'Здоровье', kk: 'Денсаулық' },
  { key: 'family', ru: 'Дети и семья', kk: 'Балалар және отбасы' },
  { key: 'cafe_gifts', ru: 'Кафе и подарки', kk: 'Кафе және сыйлықтар' },
  { key: 'utilities', ru: 'Коммуналка и связь', kk: 'Коммуналдық және байланыс' },
  { key: 'other', ru: 'Другое', kk: 'Басқа' },
];

/** More than this many chips: the rest under «Ещё ›». */
export const MAX_CHIPS = 10;

/** «By use» counts the live expenses of these last days (expenses.md, rule 2). */
export const FREQUENCY_DAYS = 90;

export type Category = {
  key: string;
  /** null until the server made the person's copy (offline before the first sync). */
  id: string | null;
  title: string;
  titleKk: string | null;
  system: boolean;
  position: string | null;
  manual: boolean;
};

const systemRank = new Map(SYSTEM_CATEGORIES.map((c, i) => [c.key, i] as const));

/** The chip categories: the server's when it answered, else the 8. Hidden and service ones never. */
export function chipCategories(server: Record<string, ExpenseCategoryOut>): Category[] {
  const list = Object.values(server).filter((c) => !c.hidden && !c.service && c.key !== TRANSFERS_KEY);
  if (list.length === 0) {
    return SYSTEM_CATEGORIES.map((c) => ({ key: c.key, id: null, title: c.ru, titleKk: c.kk, system: true, position: null, manual: false }));
  }
  const draft = new Map(SYSTEM_CATEGORIES.map((c) => [c.key, c.kk] as const));
  return list.map((c) => ({
    key: c.key,
    id: c.id,
    title: c.title,
    titleKk: c.title_kk ?? (c.system ? (draft.get(c.key) ?? null) : null),
    system: c.system,
    position: c.position,
    manual: c.manual,
  }));
}

/** A category's title by key, also for hidden ones (an old expense keeps its category). */
export function categoryByKey(server: Record<string, ExpenseCategoryOut>, key: string | null): Category | null {
  if (!key) return null;
  const s = server[key];
  if (s) return { key, id: s.id, title: s.title, titleKk: s.title_kk, system: s.system, position: s.position, manual: s.manual };
  const local = SYSTEM_CATEGORIES.find((c) => c.key === key);
  return local ? { key, id: null, title: local.ru, titleKk: local.kk, system: true, position: null, manual: false } : null;
}

export const categoryTitle = (c: Pick<Category, 'title' | 'titleKk'>, lang: string) => (lang === 'kk' && c.titleKk) || c.title;

const byPosition = (a: Category, b: Category) => {
  const pa = a.position;
  const pb = b.position;
  if (pa === pb) return (systemRank.get(a.key) ?? 99) - (systemRank.get(b.key) ?? 99);
  if (pa === null) return 1;
  if (pb === null) return -1;
  return pa < pb ? -1 : 1; // byte order of the string, like the server
};

/**
 * The chips in order (expenses.md «Order of the chips», the same rule as the server):
 * 1. the person's order on its way (`pending`, keys), else, when any category is `manual`, by `position`;
 * 2. else by use: live expenses of the last 90 days, most first, ties by `position`; own ones after the 8.
 */
export function orderedCategories(cats: Category[], entries: readonly ExpenseOut[], today: string, pending: string[] | null): Category[] {
  if (pending) {
    const byKey = new Map(cats.map((c) => [c.key, c] as const));
    const first = pending.map((k) => byKey.get(k)).filter((c): c is Category => !!c);
    return [...first, ...cats.filter((c) => !pending.includes(c.key)).sort(byPosition)];
  }
  if (cats.some((c) => c.manual)) return [...cats].sort(byPosition);
  // The server's window: `spent_on >= today - 90 days`, no upper bound.
  const since = addDays(today, -FREQUENCY_DAYS);
  const uses = new Map<string, number>();
  for (const e of entries) {
    if (e.deleted_at || !e.category_key || e.spent_on < since) continue;
    uses.set(e.category_key, (uses.get(e.category_key) ?? 0) + 1);
  }
  return [...cats].sort(
    (a, b) => Number(b.system) - Number(a.system) || (uses.get(b.key) ?? 0) - (uses.get(a.key) ?? 0) || byPosition(a, b),
  );
}
