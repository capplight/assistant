import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import { taskOut } from '@/api/endpoints';
import type { TaskOut } from '@/api/types';
import { getSyncEngine } from '@/services';
import { usePages, type Page } from '@/store/pages';
import { useTasks } from '@/tasks/store';
import { happyServer, itemOut, linkOut, type FakeServer } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages, testRecords } from '@/testing/helpers';
import { auditLayout, AUDIT_MATRIX, resetWindow, setWindow } from '@/testing/layoutAudit';
import { noteColumnsFor } from '@/theme';

/**
 * Week 19 (design «Мята / Глубина», ux-audit P0-2, P0-4, P0-5; notes-tasks-shopping rules 2, 5–7; Ф-38, Ф-40):
 * the restyled pages «Заметки», «Дела», «Покупки» and «Настроить страницу» across the width × font matrix
 * (320 / 360 / 412 / 600 / 840 × 100 / 130 / 200 %), the one-line header with 🔍 and ⋯, sticker columns by
 * width, a tap on a shopping row = bought. Structural checks only: Jest has no text layout.
 */

const iso = () => new Date().toISOString();
const LONG = 'Позвонить Ерлану насчёт плитки и замера в ванной, взять с собой рулетку и договор — до пятницы';

function task(id: string, extra: Partial<TaskOut> = {}): TaskOut {
  return taskOut({
    id, client_id: `c-${id}`, item_id: `srv-${id}`, list_key: 'shopping', title: id, qty: null, where: null, due_date: null,
    done: false, done_at: null, version: 3, seq: 1, created_at: iso(), updated_at: iso(), deleted_at: null, ...extra,
  })!;
}

function server(): FakeServer {
  return happyServer()
    .on('GET /page-templates', () => ({ status: 200, body: { templates: [] } }))
    .on('GET /collections', () => ({ status: 200, body: { collections: [] } }))
    .on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [] } }));
}

async function serverPage(key: Page['templateKey'], texts: string[]): Promise<Page> {
  const local = usePages.getState().pages.find((p) => p.templateKey === key) ?? usePages.getState().addPage(key)!;
  const synced: Page = { ...local, serverId: `srv-${key}`, syncState: 'synced' };
  usePages.setState((st) => ({ pages: st.pages.map((p) => (p.id === local.id ? synced : p)) }));
  await testPages.insertLocal(synced);
  for (const [i, text] of texts.entries()) {
    await testRecords.applyRemote(itemOut(`${key}${i}`, 50 + i, { text, status: 'ready' }));
    await testPages.applyLink(linkOut(`srv-${key}`, `srv-${key}${i}`, 60 + i, { position: String.fromCharCode(85 + i) }));
  }
  return synced;
}

async function seed(): Promise<Record<'notes' | 'tasks' | 'shopping', Page>> {
  const s = server();
  resetApp({ fetch: s.fetch });
  finishOnboarding('full');
  await (await getSyncEngine()).run();
  s.offline = true;
  const notes = await serverPage('notes', [`Код домофона\n4512, подъезд 3`, LONG, 'Шины', 'Wi-Fi на даче']);
  const tasks = await serverPage('tasks', [LONG, 'Оплатить интернет']);
  const shopping = await serverPage('shopping', ['Молоко', 'Хлеб']);
  useTasks.setState({
    tasks: {
      t0: task('t0', { list_key: 'todo', title: LONG, item_id: 'srv-tasks0' }),
      t1: task('t1', { list_key: 'todo', title: 'Оплатить интернет', item_id: 'srv-tasks1', due_date: '2020-01-02' }),
      m: task('m', { title: 'Молоко', item_id: 'srv-shopping0', qty: '2' }),
      h: task('h', { title: 'Хлеб', item_id: 'srv-shopping1' }),
    },
  });
  return { notes, tasks, shopping };
}

const settleUi = async () => {
  for (let i = 0; i < 10; i++) await act(async () => void (await jest.advanceTimersByTimeAsync(40)));
};

afterEach(() => resetWindow());

describe('«Заметки»: the sticker grid (design-system §3 StickyNote)', () => {
  it.each([
    [320, 1],
    [360, 1],
    [360, 2],
    [600, 1],
    [840, 1.3],
  ] as const)('%s dp at %s×: columns follow the layout; no border, no ⋯ on a sticker', async (width, fontScale) => {
    setWindow({ width, height: 900, fontScale });
    const { notes } = await seed();
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('record-notes0') !== null);
    const cols = noteColumnsFor(width, fontScale);
    // The first line of the grid holds `cols` stickers (a short last line is padded with empty cells).
    // One column (large font, narrow phone): plain rows, no grid lines.
    if (cols > 1) expect(screen.getByTestId('sticker-notes0').parent!.parent!.parent!.children).toHaveLength(cols);
    else expect(StyleSheet.flatten(screen.getByTestId('sticker-notes0').parent!.parent!.props.style)?.flexDirection).not.toBe('row');
    const style = StyleSheet.flatten(screen.getByTestId('record-notes0').props.style);
    expect(style.borderWidth ?? 0).toBe(0);
    expect(style.borderRadius).toBe(14);
    expect(screen.queryByTestId('record-menu-notes0')).toBeNull();
    // Ф-38: no «Ряды | Доска» while the board is off.
    expect(screen.queryByTestId('notes-mode-board')).toBeNull();
    // Title + body: the first line is the sticker's title.
    expect(screen.getByText('Код домофона')).toBeTruthy();
  });
});

describe('the page header: one line (ux-audit P0-2)', () => {
  it('title, 🔍 and ⋯ only; «Порядок» and «Настроить» are in ⋯; the field opens on 🔍 and closes again', async () => {
    const { tasks } = await seed();
    const r = await renderRouter(APP_DIR, { initialUrl: `/page/${tasks.id}` });
    await settle(() => screen.queryByTestId('page-title') !== null);
    expect(screen.getByTestId('page-search').props.accessibilityLabel).toBe('Найти на странице');
    expect(screen.queryByTestId('page-find')).toBeNull();
    expect(screen.queryByTestId('page-order')).toBeNull();
    expect(screen.queryByTestId('page-settings')).toBeNull();
    await fireEvent.press(screen.getByTestId('page-menu'));
    await settle(() => screen.queryByTestId('page-menu-sheet') !== null);
    expect(screen.getByTestId('page-order')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('page-settings'));
    await settle(() => r.getPathname() === `/page-settings/${tasks.id}`);
  });

  it('🔍 opens the field; ✕ clears and hides it', async () => {
    const { notes } = await seed();
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('page-search') !== null);
    await fireEvent.press(screen.getByTestId('page-search'));
    await fireEvent.changeText(screen.getByTestId('page-find'), 'шины');
    await settle(() => screen.queryByText('Wi-Fi на даче') === null);
    await fireEvent.press(screen.getByTestId('page-search'));
    await settle(() => screen.queryByTestId('page-find') === null && screen.queryByText('Wi-Fi на даче') !== null);
  });
});

describe('«Дела» and «Покупки»: round checks, the row is the target', () => {
  it('«Дела»: a 24 circle in a row, the segments are one SegmentedControl with the count inside', async () => {
    const { tasks } = await seed();
    await renderRouter(APP_DIR, { initialUrl: `/page/${tasks.id}` });
    await settle(() => screen.queryByTestId('task-t0') !== null);
    expect(screen.getByTestId('tasks-segments').props.accessibilityRole).toBe('tablist');
    expect(screen.getByTestId('seg-missed')).toHaveTextContent('Пропущено · 1');
    expect(screen.queryByTestId('task-menu-t0')).toBeNull();
    expect(screen.getByTestId('task-t0').props.accessibilityRole).toBe('checkbox');
  });

  it('«Покупки»: a tap on the whole row = bought; the amount is text, no «− 2 +» on the row', async () => {
    const { shopping } = await seed();
    await renderRouter(APP_DIR, { initialUrl: `/page/${shopping.id}` });
    await settle(() => screen.queryByTestId('task-h') !== null);
    expect(screen.getByTestId('qty-m')).toHaveTextContent('2');
    expect(screen.queryByTestId('qty-plus-m')).toBeNull();
    await fireEvent.press(screen.getByTestId('task-h'));
    await settle(() => screen.getByTestId('task-h').props.accessibilityState?.checked === true);
    expect(screen.getByTestId('shop-left')).toHaveTextContent('Осталось 1 из 2');
  });

  it('«Я в магазине»: big rows, no tabs, a tap = bought, «Выйти» is the back row', async () => {
    const { shopping } = await seed();
    await renderRouter(APP_DIR, { initialUrl: `/page/${shopping.id}` });
    await settle(() => screen.queryByTestId('shop-mode') !== null);
    await fireEvent.press(screen.getByTestId('shop-mode'));
    await settle(() => screen.queryByTestId('shop-mode-screen') !== null);
    expect(screen.queryByTestId('bottom-tabs')).toBeNull();
    expect(StyleSheet.flatten(screen.getByTestId('task-m').props.style).minHeight).toBeGreaterThanOrEqual(64);
    await fireEvent.press(screen.getByTestId('task-m'));
    await settle(() => screen.queryByTestId('task-m') === null);
    expect(screen.getByTestId('shop-mode-left')).toHaveTextContent('Осталось 1');
  });
});

describe('the matrix: width × font (README «Adaptive rules»)', () => {
  it.each(AUDIT_MATRIX.map((w) => [`${w.width} @ ${w.fontScale}`, w] as const))('«Заметки», «Дела», «Покупки», S38 at %s', async (_n, w) => {
    setWindow(w);
    const pages = await seed();
    for (const url of [`/page/${pages.notes.id}`, `/page/${pages.tasks.id}`, `/page/${pages.shopping.id}`, `/page-settings/${pages.notes.id}`]) {
      await renderRouter(APP_DIR, { initialUrl: url });
      await settleUi();
      expect(auditLayout(screen.toJSON(), { windowWidth: w.width }).map((v) => `${url} ${v.rule} @ ${v.where}: ${v.detail}`)).toEqual([]);
      screen.unmount();
    }
  });
});
