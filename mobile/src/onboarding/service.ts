import type { StartPath } from '@/api/types';
import { getOutbox, getPagesRepo } from '@/db';
import i18n from '@/i18n';
import { getApi, getSyncEngine, kickSync, notifyDataChanged } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { usePages, type Page, type PageCreatedBy } from '@/store/pages';
import { useUndo } from '@/store/undo';
import type { PagesBatchPayload } from '@/sync/engine';
import { undoServerAction } from '@/tasks/actions';
import { newId } from '@/utils/id';
import { TEMPLATES, type TemplateKey } from '@/pages/templates';

/**
 * Week 16 — the first launch «как в Excel» (Ф-24, R-60, 3-engineering 6.14) and S35 outside it.
 * Pages are made on the phone at once (offline and «Без ИИ» too); the server gets the whole
 * choice in one `POST /pages/batch` (one action → one «Отменить»).
 */

/** US-33: nothing chosen = Заметки + Дела и напоминания. */
export const DEFAULT_SET: readonly TemplateKey[] = ['notes', 'tasks'];

const CREATED_BY: Record<StartPath | 'skipped', PageCreatedBy> = {
  gallery: 'onboarding_gallery',
  blank: 'onboarding_blank',
  phrase_first: 'onboarding_phrase',
  skipped: 'onboarding_gallery',
};

/** `GET /onboarding`: the team's flag of the big path. Offline → the bundled default (phrase first). */
export async function loadStartConfig(): Promise<void> {
  try {
    const c = await getApi().onboardingConfig();
    useOnboarding.getState().setStartConfig({ defaultPath: c.default_path, pathsEnabled: c.paths_enabled });
  } catch {
    // the default stays: phrase first, all three paths
  }
}

const pagesText = (n: number) => i18n.t('gallery.added', { count: n });

async function enqueueBatch(pages: Page[], path: PagesBatchPayload['path']): Promise<string> {
  const repo = await getPagesRepo();
  for (const p of pages) await repo.insertLocal(p);
  const payload: PagesBatchPayload = { clientId: newId(), path, pages };
  const row = await (await getOutbox()).enqueue('pages.batch', payload);
  notifyDataChanged();
  kickSync();
  return row.id;
}

/**
 * «Отменить» of «Добавил 3 страницы»: still waiting → the row is dropped and the pages go from this
 * phone; sent → the undo of its action (the pages come back removed through /sync).
 */
export async function undoBatch(outboxId: string): Promise<void> {
  const engine = await getSyncEngine();
  await engine.hold(outboxId);
  try {
    const outbox = await getOutbox();
    const row = await outbox.get(outboxId);
    if (!row || row.status === 'failed') return;
    const p = row.payload as PagesBatchPayload;
    const ids = new Set(p.pages.map((x) => x.id));
    const repo = await getPagesRepo();
    if (row.status === 'pending') await outbox.markFailed(row.id, 'undone');
    else if (p.actionId) await undoServerAction(p.actionId);
    for (const id of ids) await repo.setRemoved(id, Date.now(), false);
    usePages.setState((s) => ({ pages: s.pages.filter((x) => !ids.has(x.id)) }));
    notifyDataChanged();
  } finally {
    engine.release(outboxId);
    kickSync();
  }
}

/** First launch: the chosen set replaces the seed pages. Tab order = the catalogue's order. */
export async function startWithPages(keys: TemplateKey[], path: StartPath | 'skipped'): Promise<Page[]> {
  const ordered = TEMPLATES.map((t) => t.key).filter((k) => keys.includes(k));
  const pages = usePages.getState().createFromOnboarding(ordered, CREATED_BY[path]);
  if (pages.length === 0) return pages;
  const rowId = await enqueueBatch(pages, path);
  if (path !== 'skipped' && path !== 'blank') {
    useUndo.getState().showCustom(pagesText(pages.length), () => void undoBatch(rowId));
  }
  return pages;
}

/** S35 from «Мои страницы» → «Готовые страницы»: «Добавить (N)», the pages go after the others. */
export async function addTemplatePages(keys: TemplateKey[]): Promise<Page[]> {
  const ordered = TEMPLATES.map((t) => t.key).filter((k) => keys.includes(k));
  const added: Page[] = [];
  for (const k of ordered) {
    const p = usePages.getState().addPage(k);
    if (p) added.push(p);
  }
  if (added.length === 0) return added;
  const rowId = await enqueueBatch(added, 'catalog');
  useUndo.getState().showCustom(pagesText(added.length), () => void undoBatch(rowId), added[0]?.id ?? null);
  return added;
}

/**
 * US-33: the app was closed on S41 / S03 / S35 without a choice → this launch opens «Сегодня» with
 * the default set, not S41 again. Called once per launch, before the first screen is decided.
 */
const LAUNCHED_AT = Date.now();

export function startNotChosenBefore(): boolean {
  const s = useOnboarding.getState();
  if (s.doneAt || !s.consent || !s.startShownAt) return false;
  return Date.parse(s.startShownAt) < LAUNCHED_AT;
}

export async function finishWithDefaults(): Promise<void> {
  const s = useOnboarding.getState();
  if (s.doneAt) return;
  s.complete();
  await startWithPages([...DEFAULT_SET], 'skipped');
}

/** Events go only with the `analytics` consent (events.md); S05 does not ask for it yet. */
function analyticsAllowed(): boolean {
  return ((useOnboarding.getState().consent?.kinds ?? []) as string[]).includes('analytics');
}

async function sendEvent(name: string, props: Record<string, string | number | boolean>): Promise<void> {
  if (!analyticsAllowed()) return;
  await (await getOutbox()).enqueue('events.send', {
    events: [{ client_id: newId(), name, props, client_ts: new Date().toISOString() }],
  });
  kickSync();
}

/**
 * US-14: the first result after S41, both clocks (from the first launch, from the chosen path).
 * Kept on the phone always; sent as the `first_value` event (seconds and codes only) when the
 * person gave the `analytics` consent.
 */
export async function noteFirstValue(kind: 'reminder' | 'task' | 'record' | 'expense'): Promise<void> {
  const s = useOnboarding.getState();
  if (s.firstValueAt || !s.pathAt || !s.path || s.path === 'skipped') return;
  const at = s.markFirstValue();
  if (!at) return;
  const end = Date.parse(at);
  const secs = (from: string | null) => (from ? Math.max(0, Math.round((end - Date.parse(from)) / 1000)) : 0);
  await sendEvent('first_value', {
    kind,
    path: s.path,
    seconds_from_open: secs(s.openedAt ?? s.welcomeSeenAt),
    seconds_from_path: secs(s.pathAt),
  });
}

/** `onboarding_path_chosen` (events.md). */
export function notePathChosen(path: StartPath): void {
  const s = useOnboarding.getState();
  const ms = s.openedAt ? Math.max(0, Date.now() - Date.parse(s.openedAt)) : 0;
  void sendEvent('onboarding_path_chosen', { path, is_default: path === s.defaultPath, ms_from_open: ms });
}
