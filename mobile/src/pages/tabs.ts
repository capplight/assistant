import { comparePages, type Page } from '@/store/pages';

import type { TemplateKey } from './templates';

/** A fixed tab slot (Ф-48): a template's page, or `null` while that page does not exist yet. */
export type TabSlot = { key: 'notes' | 'expenses' | 'tasks'; page: Page | null; centre: boolean };

/**
 * Ф-48 / Ф-50: «Сегодня · Заметки · Расходы · Дела · Ещё», «Расходы» in the centre and always there (made on the first
 * tap when the phone has no such page yet). At font ≥150 %: «Сегодня · Расходы · Дела · Ещё» — «Заметки» go to «Ещё»,
 * «Дела» stay a tab. Every other page leads «Ещё» («Ваши страницы»). Ф-49: «Покупки» is hidden while `shopping` is off.
 */
export function mainTabs(pages: readonly Page[], o: { largeFont: boolean; shopping: boolean }): { slots: TabSlot[]; overflow: Page[] } {
  const sorted = visiblePages(pages, o.shopping);
  const first = (k: TemplateKey) => sorted.find((p) => p.templateKey === k) ?? null;
  const notes = first('notes');
  const tasks = first('tasks');
  const expenses = first('expenses');
  const slots: TabSlot[] = [];
  if (!o.largeFont && notes) slots.push({ key: 'notes', page: notes, centre: false });
  slots.push({ key: 'expenses', page: expenses, centre: true });
  if (tasks) slots.push({ key: 'tasks', page: tasks, centre: false });
  const inTabs = new Set(slots.flatMap((s) => (s.page ? [s.page.id] : [])));
  return { slots, overflow: sorted.filter((p) => !inTabs.has(p.id)) };
}

/** The pages the person can see: all but «Покупки» while the shopping list is off (Ф-49: hidden, not deleted). */
export function visiblePages(pages: readonly Page[], shopping: boolean): Page[] {
  return [...pages].filter((p) => shopping || p.templateKey !== 'shopping').sort(comparePages);
}
