import type { CustomFieldType, FieldType, PageTemplateOut, TemplateFieldOut } from '@/api/types';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistStorage } from '@/store/storage';

import type { Layout, TemplateKey } from './templates';

/**
 * The template catalogue for S38 and the view registry (pages.md «Catalogue», template-screens 4).
 * A local copy of the server's seed (migration 0007) so S38 works offline and before the first
 * `GET /page-templates`; the server's answer replaces it when it comes. Week 11 adds «Простой
 * список» (`list`) to every template (Ф-30) and the tools of weeks 11а/16а as layouts.
 */

export type CatalogField = Omit<TemplateFieldOut, 'title'> & { title: { ru: string; kk: string | null } };

export type CatalogTemplate = {
  key: TemplateKey;
  fields: CatalogField[];
  /** Views the person (and the assistant) may choose, the tool first. */
  layouts: Layout[];
  defaultLayout: Layout;
};

const f = (
  id: string,
  ru: string,
  kk: string,
  type: FieldType,
  source: string,
  o: { required?: boolean; visible?: boolean; options?: string[] } = {},
): CatalogField => ({
  id,
  title: { ru, kk },
  type,
  required: o.required ?? false,
  default_visible: o.visible ?? true,
  source,
  ...(o.options ? { options: o.options } : {}),
});

/** KK titles are developer drafts (R-39): the server sends `kk: null` until reviewed. */
const LOCAL: Record<TemplateKey, CatalogTemplate> = {
  custom: {
    key: 'custom',
    fields: [
      f('title', 'Заголовок', 'Тақырып', 'text', 'item.title', { required: true }),
      f('text', 'Текст', 'Мәтін', 'long_text', 'item.text'),
      f('date', 'Дата', 'Күні', 'date', 'item.occurred_at'),
    ],
    layouts: ['list', 'checklist', 'table'],
    defaultLayout: 'list',
  },
  notes: {
    key: 'notes',
    fields: [
      f('text', 'Текст', 'Мәтін', 'long_text', 'item.text', { required: true }),
      f('title', 'Заголовок', 'Тақырып', 'text', 'item.title'),
      f('topics', 'Темы', 'Тақырыптар', 'tags', 'envelope.topics'),
      f('date', 'Дата', 'Күні', 'date', 'item.occurred_at'),
      f('source', 'Источник', 'Дереккөз', 'text', 'item.source'),
    ],
    layouts: ['stacks', 'list', 'builtin:notes_board'],
    defaultLayout: 'stacks',
  },
  tasks: {
    key: 'tasks',
    fields: [
      f('what', 'Что', 'Не', 'text', 'task.title', { required: true }),
      f('when', 'Когда', 'Қашан', 'datetime', 'task.due_at', { required: true }),
      f('repeat', 'Повтор', 'Қайталау', 'text', 'task.repeat'),
      f('remind_how', 'Как напомнить', 'Қалай еске салу', 'enum', 'task.level', { options: ['alarm', 'notification'] }),
      f('done', 'Сделано', 'Орындалды', 'bool', 'task.done', { required: true }),
    ],
    layouts: ['builtin:tasks', 'builtin:planner', 'list'],
    defaultLayout: 'builtin:tasks',
  },
  shopping: {
    key: 'shopping',
    fields: [
      f('what', 'Что', 'Не', 'text', 'facet.what', { required: true }),
      f('qty', 'Сколько', 'Қанша', 'text', 'facet.qty'),
      f('bought', 'Куплено', 'Сатып алынды', 'bool', 'facet.bought', { required: true }),
      f('where', 'Где купить', 'Қайдан алу', 'text', 'facet.where'),
    ],
    layouts: ['checklist', 'list', 'builtin:shopping'],
    defaultLayout: 'checklist',
  },
  documents: {
    key: 'documents',
    fields: [
      f('name', 'Название', 'Атауы', 'text', 'item.title', { required: true }),
      f('doc_type', 'Тип', 'Түрі', 'enum', 'document.type', { options: ['kp', 'contract', 'receipt', 'other'] }),
      f('client', 'Клиент', 'Клиент', 'person', 'document.client'),
      f('amount', 'Сумма', 'Сома', 'money', 'document.total'),
      f('date', 'Дата', 'Күні', 'date', 'item.occurred_at'),
      f('kp_status', 'Статус КП', 'КҰ күйі', 'enum', 'document.status', { options: ['draft', 'sent', 'accepted', 'declined'] }),
    ],
    layouts: ['builtin:kp', 'list'],
    defaultLayout: 'builtin:kp',
  },
  expenses: {
    key: 'expenses',
    fields: [
      f('amount', 'Сумма', 'Сома', 'money', 'expense.amount', { required: true }),
      f('date', 'Дата', 'Күні', 'date', 'expense.spent_on', { required: true }),
      f('category', 'Категория', 'Санат', 'text', 'expense.category'),
      f('merchant', 'На что / где', 'Неге / қайда', 'text', 'expense.merchant'),
      f('method', 'Способ', 'Тәсілі', 'text', 'expense.method'),
      f('receipt', 'Чек', 'Чек', 'link', 'expense.receipt'),
    ],
    layouts: ['builtin:expenses', 'list'],
    defaultLayout: 'builtin:expenses',
  },
};

/** «Простой список» is always allowed (Ф-30), whatever an older catalogue says. */
const withList = (layouts: Layout[]): Layout[] => (layouts.includes('list') ? layouts : [...layouts, 'list']);

type CatalogState = {
  /** The server's templates by key, when it answered once. */
  server: Partial<Record<TemplateKey, PageTemplateOut>>;
  put: (list: PageTemplateOut[]) => void;
  reset: () => void;
};

export const useCatalog = create<CatalogState>()(
  persist(
    (set) => ({
      server: {},
      put: (list) =>
        set((s) => {
          const server = { ...s.server };
          for (const t of list) if (t.key in LOCAL) server[t.key as TemplateKey] = t;
          return { server };
        }),
      reset: () => set({ server: {} }),
    }),
    { name: 'catalog.v1', version: 1, storage: persistStorage, partialize: ({ server }) => ({ server }) },
  ),
);

/** The template as the server last said, else the local copy. */
export function catalogTemplate(key: TemplateKey, server = useCatalog.getState().server): CatalogTemplate {
  const local = LOCAL[key];
  const s = server[key];
  if (!s || s.fields.length === 0) return { ...local, layouts: withList(local.layouts) };
  const fields = s.fields.map((x) => {
    const mine = local.fields.find((l) => l.id === x.id);
    // The server's KK title is null until reviewed: the draft stays meanwhile.
    return { ...x, title: { ru: x.title.ru, kk: x.title.kk ?? mine?.title.kk ?? null } };
  });
  const layouts = (s.layouts.length > 0 ? s.layouts : local.layouts) as Layout[];
  return { key, fields, layouts: withList(layouts), defaultLayout: (s.default_layout as Layout) || local.defaultLayout };
}

export const fieldTitle = (field: { title: { ru: string; kk: string | null } }, lang: string) =>
  (lang === 'kk' && field.title.kk) || field.title.ru;

/** S38 «+ Своё поле»: these five types (2-design 4.6). */
export const CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = ['text', 'number', 'money', 'date', 'bool'];
export const MAX_CUSTOM_FIELDS = 5;
