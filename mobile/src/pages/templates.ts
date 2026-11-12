/**
 * Page template catalog v1 (2-design §4.5.1, 3-engineering §3.10).
 * Local copy for the skeleton; later replaced by GET /page-templates (ETag-cached).
 */
export type TemplateKey = 'notes' | 'tasks' | 'shopping' | 'documents' | 'expenses' | 'custom';
export type PageKey = 'today' | TemplateKey;

export type IconKey =
  | 'today'
  | 'documents'
  | 'tasks'
  | 'shopping'
  | 'work'
  | 'money'
  | 'other'
  | 'people'
  | 'health'
  | 'home';

export type Layout =
  | 'list'
  | 'checklist'
  | 'table'
  | 'builtin:today'
  | 'builtin:tasks'
  | 'builtin:kp'
  | 'builtin:expenses'
  | 'stacks'
  /** Week 11а / 16а tools (template-screens 4): the server's catalogue may name them already. */
  | 'builtin:notes_board'
  | 'builtin:shopping'
  | 'builtin:planner';

export type PageTemplate = {
  key: TemplateKey;
  icon: IconKey;
  /** `true` for all but custom: one system topic — one page. */
  singleton: boolean;
  defaultLayout: Layout;
  /**
   * What the phone may place here by itself before the server answered (offline too). «Заметки»
   * (founder, 2026-11-09): notes only — not tasks, shopping, receipts or documents; see
   * `pages/contents.ts` `placesLocally`. The server's rows always win.
   */
  placeAll: boolean;
};

/** The server's title of a page nobody renamed; such pages follow the app language. */
export const TEMPLATE_DEFAULT_TITLE: Record<TemplateKey, string> = {
  notes: 'Заметки',
  tasks: 'Дела и напоминания',
  shopping: 'Покупки',
  documents: 'Документы и КП',
  expenses: 'Расходы',
  custom: 'Моя страница',
};

export const TEMPLATES: readonly PageTemplate[] = [
  // Week 11а (views.md «Tool layouts», catalogue notes v4 / tasks v3 / shopping v3): the tools are the defaults.
  { key: 'notes', icon: 'documents', singleton: true, defaultLayout: 'builtin:notes_board', placeAll: true },
  { key: 'tasks', icon: 'tasks', singleton: true, defaultLayout: 'builtin:planner', placeAll: false },
  { key: 'shopping', icon: 'shopping', singleton: true, defaultLayout: 'builtin:shopping', placeAll: false },
  { key: 'documents', icon: 'work', singleton: true, defaultLayout: 'builtin:kp', placeAll: false },
  { key: 'expenses', icon: 'money', singleton: true, defaultLayout: 'builtin:expenses', placeAll: false },
  { key: 'custom', icon: 'other', singleton: false, defaultLayout: 'list', placeAll: false },
];

/** Gallery order (S35): «Своя страница» first, like «Blank workbook» in Excel. */
export const GALLERY_ORDER: readonly TemplateKey[] = ['custom', 'notes', 'tasks', 'shopping', 'documents', 'expenses'];

/** Default premarks for path 3 / skip (R-48): Notes + Tasks. */
export const DEFAULT_PREMARKED: readonly TemplateKey[] = ['notes', 'tasks'];

export const MAX_PAGES = 20; // including «Сегодня»
export const MAX_TAB_PAGES = 2;
export const MAX_TAB_PAGES_LARGE_FONT = 1;

export function getTemplate(key: TemplateKey): PageTemplate {
  const tpl = TEMPLATES.find((t) => t.key === key);
  if (!tpl) throw new Error(`Unknown template ${key}`);
  return tpl;
}
