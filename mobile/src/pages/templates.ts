/**
 * Page template catalog v1 (2-design §4.5.1, 3-engineering §3.10).
 * Local copy for the skeleton; later replaced by GET /page-templates (ETag-cached).
 */
export type TemplateKey = 'notes' | 'tasks' | 'shopping' | 'documents' | 'expenses' | 'custom';
export type PageKey = 'today' | TemplateKey;

export type IconKey = 'today' | 'documents' | 'tasks' | 'shopping' | 'work' | 'money' | 'other';

export type Layout = 'list' | 'checklist' | 'table' | 'builtin:tasks' | 'builtin:kp' | 'builtin:expenses' | 'stacks';

export type PageTemplate = {
  key: TemplateKey;
  icon: IconKey;
  /** `true` for all but custom: one system topic — one page. */
  singleton: boolean;
  defaultLayout: Layout;
};

export const TEMPLATES: readonly PageTemplate[] = [
  { key: 'notes', icon: 'documents', singleton: true, defaultLayout: 'stacks' },
  { key: 'tasks', icon: 'tasks', singleton: true, defaultLayout: 'builtin:tasks' },
  { key: 'shopping', icon: 'shopping', singleton: true, defaultLayout: 'checklist' },
  { key: 'documents', icon: 'work', singleton: true, defaultLayout: 'builtin:kp' },
  { key: 'expenses', icon: 'money', singleton: true, defaultLayout: 'builtin:expenses' },
  { key: 'custom', icon: 'other', singleton: false, defaultLayout: 'list' },
];

/** Gallery order (S35): «Своя страница» first, like «Blank workbook» in Excel. */
export const GALLERY_ORDER: readonly TemplateKey[] = ['custom', 'notes', 'tasks', 'shopping', 'documents', 'expenses'];

/** Default premarks for path 3 / skip (R-48): Notes + Tasks. */
export const DEFAULT_PREMARKED: readonly TemplateKey[] = ['notes', 'tasks'];

export const MAX_PAGES = 20; // including «Сегодня»
export const MAX_TAB_PAGES = 3;
export const MAX_TAB_PAGES_LARGE_FONT = 2;

export function getTemplate(key: TemplateKey): PageTemplate {
  const tpl = TEMPLATES.find((t) => t.key === key);
  if (!tpl) throw new Error(`Unknown template ${key}`);
  return tpl;
}
