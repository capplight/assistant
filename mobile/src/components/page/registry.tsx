import type { ComponentType, ReactElement } from 'react';

import { catalogTemplate } from '@/pages/catalog';
import type { PageEntry } from '@/pages/contents';
import type { Layout, TemplateKey } from '@/pages/templates';
import type { Page } from '@/store/pages';

import { ClassicView, SimpleListView } from './ClassicView';
import { NotebookView } from './NotebookView';

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
 * Tools by `template:layout` (or just `layout`). Week 11 has «Своя страница» (the notebook) and
 * «Простой список» for all; the other tools keep their week 3–10 middle until their weeks
 * (11а: `notes:stacks`, `tasks:builtin:tasks`, `shopping:checklist`; 12–14: expenses, documents).
 * A new tool registers itself here and nothing around it changes.
 */
const registry = new Map<string, ComponentType<ViewProps>>([
  ['custom:list', NotebookView],
  ['custom:checklist', NotebookView],
  ['custom:table', NotebookView],
  ['list', SimpleListView],
]);

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
