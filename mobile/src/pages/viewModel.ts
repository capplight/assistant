import type { CustomFieldOut, CustomFieldType, FieldPrefOut, FieldType, PageOut, SetBy } from '@/api/types';

import type { CatalogTemplate } from './catalog';
import { MAX_CUSTOM_FIELDS } from './catalog';
import type { IconKey, Layout } from './templates';

/**
 * The view of a page (R-51 widened by Ф-31, template-screens 2.8, docs/api/views.md): pure data and
 * pure changes, the same for S38 by hand and for what the assistant changes. A view never touches
 * records.
 */
export type PageView = {
  /**
   * The phone's sort key: null (`position`, the person's order), `newest` / `oldest` (server `date`
   * + `sort_dir`), or a field id as the server sent it.
   */
  sort: string | null;
  groupBy: string | null;
  /** Week 11а `view_state.group_order`: the person's order of the groups («Покупки»: the shop walk). */
  groupOrder?: string[];
  /** «Заметки» `view_state.board` → `board` (drawn from week 16а); null = the tool's default. */
  mode: string | null;
  /** Who set each setting: what the person set is theirs (the server decides «Да» with it). */
  setBy: Record<string, SetBy>;
  /** Non-empty = the whole order of fields (views.md «Fields»). */
  fieldPrefs: FieldPrefOut[];
  /** Live own fields (≤5); a removed one leaves the list, its values stay. */
  customFields: CustomFieldOut[];
  customized: boolean;
};

export const EMPTY_VIEW: PageView = {
  sort: null,
  groupBy: null,
  mode: null,
  setBy: {},
  fieldPrefs: [],
  customFields: [],
  customized: false,
};

const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The phone's sort key ↔ the server's `sort` + `sort_dir`. */
export function sortFromServer(sort: unknown, dir: unknown): string | null {
  if (typeof sort !== 'string' || !sort || sort === 'position') return null;
  if (sort === 'date') return dir === 'asc' ? 'oldest' : 'newest';
  return sort;
}

export function sortToServer(key: string | null): { sort: string | null; sort_dir?: 'asc' | 'desc' } {
  if (!key || key === 'position') return { sort: null };
  if (key === 'newest') return { sort: 'date', sort_dir: 'desc' };
  if (key === 'oldest') return { sort: 'date', sort_dir: 'asc' };
  return { sort: key, sort_dir: 'asc' };
}

export function viewFromServer(out: PageOut): PageView {
  const vs = out.view_state ?? {};
  const setBy: Record<string, SetBy> = {};
  for (const [k, v] of Object.entries((vs.set_by as Record<string, unknown> | undefined) ?? {})) {
    if (v === 'user' || v === 'agent' || v === 'template') setBy[k] = v;
  }
  return {
    sort: sortFromServer(vs.sort, vs.sort_dir),
    groupBy: s(vs.group_by),
    groupOrder: Array.isArray(vs.group_order) ? vs.group_order.filter((x): x is string => typeof x === 'string') : [],
    mode: vs.board === true ? 'board' : null,
    setBy,
    fieldPrefs: out.field_prefs ?? [],
    customFields: out.custom_fields ?? [],
    customized: out.customized === true,
  };
}

export function parseView(json: string): PageView {
  try {
    const v = JSON.parse(json) as Partial<PageView> | null;
    return { ...EMPTY_VIEW, ...(v && typeof v === 'object' ? v : {}) };
  } catch {
    return EMPTY_VIEW;
  }
}

/** One field as S38 and a table show it: template fields and own fields in one order. */
export type ShownField = {
  id: string;
  title: { ru: string; kk: string | null };
  type: FieldType | CustomFieldType;
  /** ★: never hidden. */
  required: boolean;
  visible: boolean;
  custom: boolean;
  setBy: SetBy | null;
};

/**
 * Fields in the page's order, as the server computes it (views.md «Fields»): template fields, then
 * own fields; a non-empty `field_prefs` is the order (ids it does not name go last with their
 * default, ids of fields that are gone are ignored); ★ is always shown.
 */
export function fieldsOf(tpl: CatalogTemplate, view: PageView | undefined): ShownField[] {
  const v = view ?? EMPTY_VIEW;
  const all: ShownField[] = [
    ...tpl.fields.map((f) => ({
      id: f.id,
      title: f.title,
      type: f.type,
      required: f.required,
      visible: f.required || f.default_visible,
      custom: false,
      setBy: null,
    })),
    ...v.customFields.map((c) => ({
      id: c.id,
      title: { ru: c.title, kk: null },
      type: c.type,
      required: false,
      visible: true,
      custom: true,
      setBy: c.set_by ?? null,
    })),
  ];
  if (v.fieldPrefs.length === 0) return all;
  const byId = new Map(all.map((f) => [f.id, f]));
  const named: ShownField[] = [];
  for (const p of v.fieldPrefs) {
    const f = byId.get(p.field_id);
    if (!f || named.some((n) => n.id === f.id)) continue;
    named.push({ ...f, visible: f.required ? true : p.visible, setBy: p.set_by ?? f.setBy });
  }
  return [...named, ...all.filter((f) => !named.some((n) => n.id === f.id))];
}

export const liveCustom = (view: PageView | undefined) => view?.customFields ?? [];

/** An own field's id made on the phone: `c_` + 32 hex of a uuid (views.md «A field made offline»). */
export const newFieldId = (uuid: string) => `c_${uuid.replace(/-/g, '').toLowerCase()}`;

/** One change the person makes (S38, the notebook switcher). */
export type ViewChange =
  | { kind: 'layout'; layout: Layout }
  | { kind: 'sort'; sort: string | null }
  | { kind: 'group'; groupBy: string | null }
  /** Week 11а: the whole order of the groups after one moved (↑ ↓). */
  | { kind: 'group_order'; order: string[]; moved: string }
  | { kind: 'icon'; icon: IconKey }
  | { kind: 'field_visible'; fieldId: string; visible: boolean }
  | { kind: 'field_move'; fieldId: string; step: -1 | 1 }
  | { kind: 'custom_add'; field: { id: string; title: string; type: CustomFieldType } }
  | { kind: 'custom_remove'; fieldId: string }
  | { kind: 'reset' };

export type Look = { layout: Layout; icon: IconKey; view: PageView };

export type ChangeError = 'field_required' | 'custom_limit' | 'layout_not_allowed' | 'nothing';

/** The whole order as the person sees it → `field_prefs`; own fields are the live ones in it. */
function writeFields(view: PageView, fields: ShownField[]): PageView {
  const own = new Map(view.customFields.map((c) => [c.id, c]));
  const customFields: CustomFieldOut[] = fields
    .filter((f) => f.custom)
    .map((f, order) => ({
      ...(own.get(f.id) ?? { id: f.id, title: f.title.ru, type: f.type as CustomFieldType, visible: true, set_by: 'user' as const }),
      order,
    }));
  const fieldPrefs: FieldPrefOut[] = fields.map((f, order) => ({
    field_id: f.id,
    visible: f.visible,
    order,
    ...(f.setBy ? { set_by: f.setBy } : {}),
  }));
  return { ...view, fieldPrefs, customFields, customized: true };
}

/** The look after a change, or why it cannot be (checked again by the server). */
export function applyChange(
  tpl: CatalogTemplate,
  look: Look,
  change: ViewChange,
  defaultIcon: IconKey,
): { look: Look } | { error: ChangeError } {
  const view = look.view;
  const mine = (key: string) => ({ ...view.setBy, [key]: 'user' as const });
  switch (change.kind) {
    case 'layout':
      if (!tpl.layouts.includes(change.layout)) return { error: 'layout_not_allowed' };
      if (change.layout === look.layout) return { error: 'nothing' };
      return { look: { ...look, layout: change.layout, view: { ...view, setBy: mine('layout'), customized: true } } };
    case 'sort':
      if (change.sort === view.sort) return { error: 'nothing' };
      return { look: { ...look, view: { ...view, sort: change.sort, setBy: mine('sort'), customized: true } } };
    case 'group':
      if (change.groupBy === view.groupBy) return { error: 'nothing' };
      return { look: { ...look, view: { ...view, groupBy: change.groupBy, setBy: mine('group_by'), customized: true } } };
    case 'group_order': {
      const was = view.groupOrder ?? [];
      if (was.length === change.order.length && was.every((x, i) => x === change.order[i])) return { error: 'nothing' };
      return { look: { ...look, view: { ...view, groupOrder: change.order, setBy: mine('group_order'), customized: true } } };
    }
    case 'icon':
      if (change.icon === look.icon) return { error: 'nothing' };
      return { look: { ...look, icon: change.icon, view: { ...view, setBy: mine('icon') } } };
    case 'field_visible': {
      const fields = fieldsOf(tpl, view);
      const f = fields.find((x) => x.id === change.fieldId);
      if (!f) return { error: 'nothing' };
      if (f.required && !change.visible) return { error: 'field_required' };
      if (f.visible === change.visible) return { error: 'nothing' };
      return {
        look: { ...look, view: writeFields(view, fields.map((x) => (x === f ? { ...x, visible: change.visible, setBy: 'user' } : x))) },
      };
    }
    case 'field_move': {
      const fields = fieldsOf(tpl, view);
      const i = fields.findIndex((x) => x.id === change.fieldId);
      const j = i + change.step;
      if (i < 0 || j < 0 || j >= fields.length) return { error: 'nothing' };
      const next = [...fields];
      [next[i], next[j]] = [next[j]!, { ...next[i]!, setBy: 'user' }];
      return { look: { ...look, view: writeFields(view, next) } };
    }
    case 'custom_add': {
      if (liveCustom(view).length >= MAX_CUSTOM_FIELDS) return { error: 'custom_limit' };
      const title = change.field.title.trim();
      if (!title) return { error: 'nothing' };
      // A new field with the same name is a new field: old values stay with the old id (views.md).
      const added: ShownField = {
        id: change.field.id,
        title: { ru: title, kk: null },
        type: change.field.type,
        required: false,
        visible: true,
        custom: true,
        setBy: 'user',
      };
      return { look: { ...look, view: writeFields(view, [...fieldsOf(tpl, view), added]) } };
    }
    case 'custom_remove': {
      const fields = fieldsOf(tpl, view);
      if (!fields.some((x) => x.id === change.fieldId && x.custom)) return { error: 'nothing' };
      // The values stay (server and phone); the field leaves the page.
      return { look: { ...look, view: writeFields(view, fields.filter((x) => x.id !== change.fieldId)) } };
    }
    case 'reset':
      // «Вернуть как было»: the template's look; own fields go, their values stay.
      return { look: { layout: tpl.defaultLayout, icon: defaultIcon, view: EMPTY_VIEW } };
  }
}

const prefsBody = (view: PageView) => view.fieldPrefs.map(({ field_id, visible }) => ({ field_id, visible }));

/** What one change sends to `POST /pages/{id}/view` (views.md): only the keys it touched. */
export function viewBody(change: ViewChange, after: Look): Record<string, unknown> {
  switch (change.kind) {
    case 'layout':
      return { layout: after.layout };
    case 'icon':
      return { icon: after.icon };
    case 'sort':
      return sortToServer(after.view.sort);
    case 'group':
      return { group_by: after.view.groupBy };
    case 'group_order':
      return { group_order: after.view.groupOrder ?? [] };
    case 'field_visible':
    case 'field_move':
      return { fields: prefsBody(after.view) };
    case 'custom_add':
      return { add_fields: [{ id: change.field.id, title: change.field.title.trim(), type: change.field.type }] };
    case 'custom_remove':
      return { remove_fields: [change.fieldId] };
    case 'reset':
      return { reset: true };
  }
}

/** «Отменить» of a change the server answered without an action: the old look as one call. */
export function restoreBody(look: Look): Record<string, unknown> {
  return {
    layout: look.layout,
    icon: look.icon,
    ...sortToServer(look.view.sort),
    group_by: look.view.groupBy,
    group_order: (look.view.groupOrder ?? []).length > 0 ? look.view.groupOrder : null,
    ...(look.view.fieldPrefs.length > 0 ? { fields: prefsBody(look.view) } : {}),
  };
}

/** Fields a page may be grouped by (views.md: not long text, numbers, sums, date-time, links). */
export const groupable = (f: ShownField) => !['long_text', 'number', 'money', 'datetime', 'link'].includes(f.type);
