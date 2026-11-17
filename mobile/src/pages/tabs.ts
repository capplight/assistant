import { comparePages, type Page } from '@/store/pages';

import type { TemplateKey } from './templates';

/**
 * A tab slot (Ф-58, design-system v3 §9.1): a template's page (null while it does not exist yet) or the
 * assistant's conversation in the centre.
 */
export type TabSlot =
  | { key: 'notes' | 'expenses'; page: Page | null; centre: false }
  | { key: 'assistant'; page: null; centre: true };

/**
 * Ф-58: «Сегодня · Заметки · Помощник · Расходы · Ещё» — the assistant's conversation is the raised centre; «Расходы»
 * right of it (made on the first tap when the phone has no such page). «Дела» left the tab bar: «Все дела ›» on
 * «Сегодня» and a row in «Ещё». v5 (Ф-79, design-system §11.5): the same five tabs at every font size — the labels are
 * capped at 13 instead (`largeFont` is ignored). Every other page leads «Ещё». Ф-49: «Покупки» is hidden while
 * `shopping` is off.
 */
export function mainTabs(pages: readonly Page[], o: { largeFont: boolean; shopping: boolean }): { slots: TabSlot[]; overflow: Page[] } {
  const sorted = visiblePages(pages, o.shopping);
  const first = (k: TemplateKey) => sorted.find((p) => p.templateKey === k) ?? null;
  const notes = first('notes');
  const expenses = first('expenses');
  const slots: TabSlot[] = [];
  if (notes) slots.push({ key: 'notes', page: notes, centre: false });
  slots.push({ key: 'assistant', page: null, centre: true });
  slots.push({ key: 'expenses', page: expenses, centre: false });
  const inTabs = new Set(slots.flatMap((s) => (s.page ? [s.page.id] : [])));
  return { slots, overflow: sorted.filter((p) => !inTabs.has(p.id)) };
}

/** The pages the person can see: all but «Покупки» while the shopping list is off (Ф-49: hidden, not deleted). */
export function visiblePages(pages: readonly Page[], shopping: boolean): Page[] {
  return [...pages].filter((p) => shopping || p.templateKey !== 'shopping').sort(comparePages);
}
