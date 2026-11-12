import type { ComponentType, ReactElement } from 'react';

import { catalogTemplate } from '@/pages/catalog';
import type { PageEntry } from '@/pages/contents';
import type { Layout, TemplateKey } from '@/pages/templates';
import type { Page } from '@/store/pages';

import { ClassicView, SimpleListView } from './ClassicView';
import { DocumentsView } from './DocumentsView';
import { ExpensesView } from './ExpensesView';
import { NotebookView } from './NotebookView';
import { PlannerView } from './PlannerView';
import { ShoppingView } from './ShoppingView';
import { StickersView } from './StickersView';

/**
 * What a tool gets from the frame (template-screens 3, «по краям всё одинаковое, в середине —
 * инструмент»): the page, its records in the person's order, the frame's top (title, «Порядок»,
 * «Настроить», «Найти») to put first in its scroll, and whether «Порядок» is on. The bottom edge
 * (the assistant line, the answer banner, «Отменить») and S09 stay outside the tool.
 */
export type ViewProps = {
  page: Page;
  entries: PageEntry[] | null;
  frameTop: ReactElement;
  ordering: boolean;
};

export type ViewDef = { key: string; Component: ComponentType<ViewProps> };

/**
 * Tools by `template:layout` (or just `layout`). Week 11: «Своя страница» (the notebook) and
 * «Простой список» for all. Week 11а: the sticker wall, the day planner and the fridge list are the
 * defaults (catalogue notes v4, tasks v3, shopping v3); the older middles stay as the other allowed
 * views (`stacks`, `builtin:tasks`, `checklist`). Week 12: the expense calculator. Week 14: documents.
 * A new tool registers itself here and nothing around it changes.
 */
const registry = new Map<string, ComponentType<ViewProps>>([
  ['custom:list', NotebookView],
  ['custom:checklist', NotebookView],
  ['custom:table', NotebookView],
  ['notes:builtin:notes_board', StickersView],
  ['tasks:builtin:planner', PlannerView],
  ['shopping:builtin:shopping', ShoppingView],
  // Week 12: «Расходы» — the expense calculator (template-screens 2.2).
  ['expenses:builtin:expenses', ExpensesView],
  // Week 14: «Документы и КП» — the card file (template-screens 2.5).
  ['documents:builtin:kp', DocumentsView],
  ['notes:stacks', ClassicView],
  ['tasks:builtin:tasks', ClassicView],
  ['shopping:checklist', ClassicView],
  ['list', SimpleListView],
]);

/** Week 17: every registered tool (the 200% test renders each one). */
export function registeredViewKeys(): string[] {
  return [...registry.keys()];
}

export function registerView(key: `${TemplateKey}:${Layout}` | Layout, Component: ComponentType<ViewProps>): void {
  registry.set(key, Component);
}

/** The layout a page shows: its own when the template allows it, else the template's default. */
export function effectiveLayout(page: Pick<Page, 'templateKey' | 'layout'>): Layout {
  const tpl = catalogTemplate(page.templateKey);
  return tpl.layouts.includes(page.layout) ? page.layout : tpl.defaultLayout;
}

/**
 * Whether S38 may offer this view: the template's own tool, «Простой список», or a tool that is
 * built (the catalogue already names «Доска», «Ежедневник», «Список покупок» of weeks 11а–16а;
 * they are not offered before they exist).
 */
export function hasTool(templateKey: TemplateKey, layout: Layout, defaultLayout: Layout): boolean {
  return layout === defaultLayout || layout === 'list' || registry.has(`${templateKey}:${layout}`);
}

export function resolveView(page: Page): ViewDef {
  const layout = effectiveLayout(page);
  const own = registry.get(`${page.templateKey}:${layout}`) ?? registry.get(layout);
  return { key: `${page.templateKey}:${layout}`, Component: own ?? ClassicView };
}
