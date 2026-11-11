import type { ExpenseOut, TaskOut, TodayTileOut } from '@/api/types';
import { addDays, formatMinor, sumOf, type CalcRow } from '@/expenses/calc';
import type { Page } from '@/store/pages';

/**
 * «На страницах» on «Сегодня» (Ф-32, template-screens 2.7, onboarding.md «page tiles»): ≤2 tiles,
 * by code, never by the model. The rule picks none in the first 7 days; a tile pinned by hand shows
 * from the first day, a hidden one never (today.md week 16). Pinned first
 * (tab order), then the pages that have something for today (tab order); «Дела» are in the day
 * list already, so they get a tile only when pinned; a hidden page never shows one.
 * Online: the server's `page_tiles`. Offline / no answer yet: the phone builds the same from its
 * own copy for «Покупки» and «Расходы» («Документы и КП» needs the server).
 */

export const MAX_TILES = 2;
export const NO_TILES_DAYS = 7;
const DAY = 86_400_000;

export type Tile = { pageId: string; templateKey: string; text: string; pinned: boolean };

export type TileInput = {
  /** In tab order. */
  pages: Page[];
  /** The account's first launch (null: treat as new). */
  startedAt: string | null;
  now: number;
  today: string;
  /** The server's tiles of the last `/today`; null when none came (offline). */
  server: TodayTileOut[] | null;
  toBuy: TaskOut[];
  expenses: ExpenseOut[];
  t: (k: string, o?: Record<string, unknown>) => string;
};

const modeOf = (p: Page) => p.view?.todayTile ?? 'auto';

/** (what the page has for today or null, the line of a pinned tile with nothing) — as the server. */
function localText(p: Page, i: TileInput): [string | null, string] {
  if (p.templateKey === 'shopping') {
    const n = i.toBuy.length;
    return [n > 0 ? i.t('today.tile_left', { n }) : null, i.t('today.tile_all_bought')];
  }
  if (p.templateKey === 'expenses') {
    const live = i.expenses.filter((e) => !e.deleted_at && e.direction === 'expense');
    const weekAgo = addDays(i.today, -6);
    if (!live.some((e) => e.spent_on >= weekAgo && e.spent_on <= i.today)) return [null, i.t('today.tile_no_spend')];
    const todays = live.filter((e) => e.spent_on === i.today);
    const currencies = [...new Set(todays.map((e) => e.currency))].sort((a, b) => (a === 'KZT' ? -1 : b === 'KZT' ? 1 : a.localeCompare(b)));
    if (currencies.length === 0) return [i.t('today.tile_no_spend'), i.t('today.tile_no_spend')];
    const parts = currencies.map((c) => {
      const rows: CalcRow[] = todays
        .filter((e) => e.currency === c)
        .map((e) => ({ id: e.id, amount: e.amount, currency: e.currency, direction: e.direction, spent_on: e.spent_on, category: null }));
      return formatMinor(sumOf(rows, c), c);
    });
    return [i.t('today.tile_spent', { sum: parts.join(' · ') }), i.t('today.tile_no_spend')];
  }
  return [null, ''];
}

export function todayTiles(i: TileInput): Tile[] {
  const young = !i.startedAt || i.now - Date.parse(i.startedAt) < NO_TILES_DAYS * DAY;
  const byServerId = new Map((i.server ?? []).map((x) => [x.page_id, x]));
  const serverTile = (p: Page) => (p.serverId ? byServerId.get(p.serverId) : undefined);
  // Pinned by hand: the person's, shown from the first day (today.md), in tab order.
  const pinned: Tile[] = i.pages
    .filter((p) => modeOf(p) === 'pinned')
    .map((p) => {
      const [has, empty] = localText(p, i);
      return { pageId: p.id, templateKey: p.templateKey, text: serverTile(p)?.text_ru ?? has ?? empty, pinned: true };
    });
  if (young) return pinned.slice(0, MAX_TILES);
  let auto: Tile[];
  if (i.server) {
    const byId = new Map(i.pages.flatMap((p) => (p.serverId ? [[p.serverId, p] as const] : [])));
    auto = i.server.flatMap((x) => {
      const p = byId.get(x.page_id);
      // a hidden page never shows; a pinned one is above already (the person may have just changed it)
      if (!p || modeOf(p) !== 'auto') return [];
      return [{ pageId: p.id, templateKey: x.template_key, text: x.text_ru, pinned: false }];
    });
  } else {
    auto = [];
    for (const p of i.pages) {
      if (modeOf(p) !== 'auto' || p.templateKey === 'tasks') continue;
      const [has] = localText(p, i);
      if (has) auto.push({ pageId: p.id, templateKey: p.templateKey, text: has, pinned: false });
    }
  }
  return [...pinned, ...auto].slice(0, MAX_TILES);
}
