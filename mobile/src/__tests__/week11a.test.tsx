import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { Dimensions } from 'react-native';

import { appearanceOut, fireOut, reminderOut, taskOut } from '@/api/endpoints';
import type { TaskOut } from '@/api/types';
import { useAlarms } from '@/alarms/store';
import { resolveView } from '@/components/page/registry';
import { toLines } from '@/components/page/EntryList';
import { byPlace } from '@/components/page/ShoppingView';
import { entryRow } from '@/components/page/rows';
import type { InMemoryOutboxRepository } from '@/db';
import { comparePageEntries, type PageEntry } from '@/pages/contents';
import { EMPTY_VIEW } from '@/pages/viewModel';
import { getSyncEngine } from '@/services';
import { usePages, type Page } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import { qtyCount, qtyText } from '@/tasks/edit';
import type { ListRow } from '@/tasks/rows';
import { sheetSlots, timedItemIds } from '@/tasks/sheet';
import { useTasks } from '@/tasks/store';
import { lightNoteColors, NOTE_COLOR_KEYS } from '@/theme';
import { happyServer, itemOut, linkOut, type FakeServer, type SseEvent } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages, testRecords } from '@/testing/helpers';

/**
 * Week 11а (template-screens 2.1, 2.3, 2.4, 3, 5; docs/api/views.md, pages.md, today.md as of
 * 2026-11-09): the sticker wall «Ряды» of «Заметки», the day planner of «Дела», the fridge list
 * of «Покупки» with «Я в магазине». Fake server only: nothing here ran against the real server or
 * on a phone (smoothness of the grid on a low-end Redmi must be checked on a real phone).
 */

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const t0 = () => Date.now();

function action(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'screen_view_change',
    scope: 'internal',
    initiated_by: 'user',
    summary: { ru: summary, kk: null },
    page: null,
    changes: [],
    changed_item_ids: [],
    created_page_id: null,
    undoable: true,
    undoable_until: iso(t0() + 30 * 86_400_000),
    undone_at: null,
    undo_of: null,
    message_id: null,
    seq: 10,
    created_at: iso(t0()),
    ...extra,
  };
}

function task(id: string, extra: Partial<TaskOut> = {}): TaskOut {
  return taskOut({
    id,
    client_id: `c-${id}`,
    item_id: `srv-${id}`,
    list_key: 'shopping',
    title: id,
    qty: null,
    where: null,
    due_date: null,
    done: false,
    done_at: null,
    version: 3,
    seq: 1,
    created_at: iso(t0()),
    updated_at: iso(t0()),
    deleted_at: null,
    ...extra,
  })!;
}

function server(): FakeServer {
  const s = happyServer();
  s.on('POST /actions/*/undo', (c) => ({
    status: 200,
    body: { action: { ...action(c.path.split('/')[2]!, 'x'), undoable: false, undone_at: iso(t0()) }, undo: null, partial: false, repeated: false, message_ru: null, page_patches: [] },
  }))
    .on('GET /actions', () => ({ status: 200, body: { actions: [], has_more: false } }))
    .on('GET /page-templates', () => ({ status: 200, body: { templates: [] } }))
    .on('GET /collections', () => ({ status: 200, body: { collections: [] } }))
    .on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [] } }))
    .on('GET /today', () => ({ status: 200, body: { sections: [], today: { reminders: [], tasks: [], shopping: null }, missed: [], done_for_you: { actions: [], count_today: 0 }, proposals: [], tip: null, empty: false } }));
  return s;
}

async function online(s: FakeServer): Promise<InMemoryOutboxRepository> {
  const outbox = resetApp({ fetch: s.fetch });
  finishOnboarding('full');
  if (!usePages.getState().pages.some((p) => p.templateKey === 'shopping')) usePages.getState().addPage('shopping');
  await (await getSyncEngine()).run();
  return outbox;
}

async function sync(outbox: InMemoryOutboxRepository) {
  const e = await getSyncEngine();
  await e.whenIdle();
  for (const r of outbox.all()) if (r.status === 'pending') await outbox.markRetry(r.id, 'test', 0);
  await e.run();
}

/** The template's page, made a server page `srv-<key>` with records on it. */
async function serverPage(key: Page['templateKey'], records: { id: string; text: string; link?: Record<string, unknown> }[] = []): Promise<Page> {
  const local = usePages.getState().pages.find((p) => p.templateKey === key)!;
  const synced: Page = { ...local, serverId: `srv-${key}`, syncState: 'synced' };
  usePages.setState((st) => ({ pages: st.pages.map((p) => (p.id === local.id ? synced : p)) }));
  await testPages.insertLocal(synced);
  for (const [i, r] of records.entries()) {
    await testRecords.applyRemote(itemOut(r.id, 50 + i, { text: r.text, status: 'ready' }));
    await testPages.applyLink(linkOut(`srv-${key}`, `srv-${r.id}`, 60 + i, { position: String.fromCharCode(85 + i), ...(r.link ?? {}) }));
  }
  return synced;
}

const pageOf = (key: string) => usePages.getState().pages.find((p) => p.templateKey === key)!;
const stripText = () => {
  const s = useUndo.getState().strip;
  return s?.kind === 'custom' ? s.text : null;
};
const bg = (id: string) => {
  const style = screen.getByTestId(id).props.style;
  return (Array.isArray(style) ? Object.assign({}, ...style.flat()) : style).backgroundColor;
};

afterEach(() => {
  Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 1 }, screen: { width: 390, height: 844, scale: 3, fontScale: 1 } });
});

describe('contract (views.md, pages.md, today.md week 11а)', () => {
  it('appearance colours, unknown colour = none; the tools are the defaults and registered', () => {
    expect(appearanceOut({ color: 'yellow', color_set_by: 'user' })).toEqual({ color: 'yellow', color_set_by: 'user' });
    expect(appearanceOut({ color: 'violet' }).color).toBeNull();
    resetApp();
    const base = usePages.getState().pages[0]!;
    const as = (templateKey: Page['templateKey'], layout: string) => ({ ...base, templateKey, layout: layout as Page['layout'] });
    expect(resolveView(as('notes', 'builtin:notes_board')).key).toBe('notes:builtin:notes_board');
    expect(resolveView(as('tasks', 'builtin:planner')).key).toBe('tasks:builtin:planner');
    expect(resolveView(as('shopping', 'builtin:shopping')).key).toBe('shopping:builtin:shopping');
    // An unknown layout falls back to the template's tool.
    expect(resolveView(as('notes', 'table')).key).toBe('notes:builtin:notes_board');
  });

  it('page order: pinned first, then position (pages.md «Page order»)', () => {
    const e = (id: string, position: string, pinned = false): PageEntry =>
      ({ record: { id, serverId: id, occurredAt: iso(0), createdAt: 0 }, link: { position, pinned } }) as unknown as PageEntry;
    const list = [e('a', 'U'), e('b', 'W', true), e('c', 'V')].sort(comparePageEntries);
    expect(list.map((x) => x.record.id)).toEqual(['b', 'a', 'c']);
  });

  it('note colours: six, no violet; ink on each is ≥4.5:1', () => {
    expect(NOTE_COLOR_KEYS).toEqual(['yellow', 'pink', 'green', 'blue', 'peach', 'white']);
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (const c of Object.values(lightNoteColors)) {
      expect(ratio('#1F1D1A', c)).toBeGreaterThan(4.5);
      expect(ratio('#5E5A52', c)).toBeGreaterThan(4.5);
    }
  });
});

describe('pure parts', () => {
  it('a grid packs records two by two; a heading starts a new line', () => {
    const r = (id: string) => entryRow({ record: { id } } as unknown as PageEntry);
    const lines = toLines([r('a'), r('b'), r('c'), { type: 'group', key: 'g', title: 'G' }, r('d')], 2);
    expect(lines.map((l) => (l.type === 'line' ? l.items.map((x) => x.entry.record.id).join('') : l.type))).toEqual(['ab', 'c', 'group', 'd']);
  });

  it('«Сколько»: a plain count gets «− +», «1 кг» stays as written', () => {
    expect(qtyCount(null)).toBe(1);
    expect(qtyCount('3 шт')).toBe(3);
    expect(qtyCount('1 кг')).toBeNull();
    expect(qtyText(1)).toBeNull();
    expect(qtyText(4)).toBe('4');
  });

  it('shops: `group_order` first (case, «ё»), the rest as they appear, «Без места» last; not grouped = one list', () => {
    const row = (title: string, where: string | null): ListRow => ({ kind: 'task', task: task(title, { where }), done: false });
    const open = [row('a', null), row('b', 'Магнум'), row('c', 'Аптека'), row('d', 'магнум'), row('e', 'Базар')];
    const g = byPlace(open, { grouped: true, order: ['аптека'] });
    expect(g.map((x) => x.where)).toEqual(['Аптека', 'Магнум', 'Базар', null]);
    expect(g[1]!.rows.map((r) => r.task!.title)).toEqual(['b', 'd']);
    expect(byPlace(open, { grouped: false })).toHaveLength(1);
  });

  it('the day sheet (today.md): main fires by occurrence, acked, snoozed, missed; timed records', () => {
    const now = Date.parse('2026-11-10T10:00:00');
    const day = Date.parse('2026-11-10T00:00:00');
    const r1 = reminderOut({ id: 'r1', title: 'Таблетка', due_at: iso(day + 8 * 60 * MIN), kind: 'normal', status: 'scheduled', level: 'alarm', version: 1, item_id: 'i1' })!;
    const r2 = reminderOut({ id: 'r2', title: 'Позвонить', due_at: iso(day + 18 * 60 * MIN), kind: 'normal', status: 'scheduled', level: 'notification', version: 1 })!;
    const f = (id: string, r: string, at: number, extra: Record<string, unknown> = {}) =>
      fireOut({ id, reminder_id: r, key: `${r}:${id}`, occurrence_at: iso(at), fire_at: iso(at), offset_min: 0, snooze_n: 0, state: 'planned', ...extra })!;
    const fires = Object.fromEntries(
      [
        f('a', 'r1', day + 8 * 60 * MIN, { state: 'acked' }),
        f('b', 'r2', day + 18 * 60 * MIN),
        f('c', 'r2', day + 18 * 60 * MIN, { snooze_n: 1, fire_at: iso(day + 18 * 60 * MIN + 10 * MIN) }),
        f('d', 'r2', day + 18 * 60 * MIN, { offset_min: 60, fire_at: iso(day + 17 * 60 * MIN) }),
        f('e', 'r2', day + 26 * 60 * MIN), // tomorrow
      ].map((x) => [x.key, x]),
    );
    const slots = sheetSlots({ fires, reminders: { r1, r2 }, local: {} }, new Set(), day, day + 86_400_000);
    expect(slots.map((s) => [s.title, s.acked, s.snoozedUntil !== null])).toEqual([
      ['Таблетка', true, false],
      ['Позвонить', false, true],
    ]);
    expect(slots[0]!.itemId).toBe('i1');
    expect(timedItemIds({ r1, r2 })).toEqual(new Set(['i1']));
    expect(now).toBeGreaterThan(day);
  });
});

describe('«Заметки» — the sticker wall «Ряды»', () => {
  it('stickers in two columns; «Цвет» from «⋯» at once, offline, «Отменить» drops it; online it goes as the row call', async () => {
    const s = server();
    const outbox = await online(s);
    s.offline = true;
    const notes = await serverPage('notes', [
      { id: 'n1', text: 'Код домофона\n4512' },
      { id: 'n2', text: 'Купить грунтовку' },
      { id: 'n3', text: 'Размер окна 120 на 80' },
    ]);
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('sticker-n1') !== null);
    expect(screen.getByTestId('page-view-notes:builtin:notes_board')).toBeTruthy();
    // The frame stays the same.
    for (const id of ['page-title', 'page-order', 'page-settings', 'page-find']) expect(screen.getByTestId(id)).toBeTruthy();
    expect(screen.getByTestId('record-n1').props.accessibilityLabel).toMatch(/^Стикер 1 из 3\. белый\. Код домофона/);

    await fireEvent.press(screen.getByTestId('record-menu-n1'));
    await fireEvent.press(screen.getByTestId('menu-color'));
    await settle(() => screen.queryByTestId('color-sheet') !== null);
    expect(screen.getByTestId('color-white').props.accessibilityState).toEqual({ checked: true });
    await fireEvent.press(screen.getByTestId('color-yellow'));
    await settle(() => bg('sticker-n1') === lightNoteColors.yellow);
    expect(stripText()).toBe('Жёлтый: Код домофона\n4512');
    const row = outbox.all().find((r) => r.kind === 'page.item_look')!;
    expect(row.payload).toMatchObject({ color: 'yellow' });
    // «Отменить» while it waits: it never goes, the colour is back.
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => bg('sticker-n1') === lightNoteColors.white);
    expect((await outbox.get(row.id))?.status).toBe('failed');

    s.on('PATCH /pages/*/items/*', (c) => ({
      status: 200,
      body: {
        link: linkOut('srv-notes', 'srv-n2', 99, { position: 'V', appearance: { color: 'green', color_set_by: 'user' } }),
        values: {},
        repeated: false,
        action: action('acol', 'Цвет: зелёный'),
      },
    }));
    s.offline = false;
    await fireEvent.press(screen.getByTestId('record-menu-n2'));
    await fireEvent.press(screen.getByTestId('menu-color'));
    await settle(() => screen.queryByTestId('color-green') !== null);
    await fireEvent.press(screen.getByTestId('color-green'));
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => s.callsTo('PATCH /pages/srv-notes/items/srv-n2').length === 1);
    expect(s.callsTo('PATCH /pages/srv-notes/items/srv-n2')[0]!.body).toMatchObject({ color: 'green' });
    await settle(() => bg('sticker-n2') === lightNoteColors.green);
    // Sent: «Отменить» is the undo of its action.
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => s.callsTo('POST /actions/acol/undo').length === 1);
  });

  it('«Приколоть наверх»: the sticker goes first at once, with a pin', async () => {
    const s = server();
    const outbox = await online(s);
    s.offline = true;
    const notes = await serverPage('notes', [
      { id: 'n1', text: 'Первая' },
      { id: 'n2', text: 'Вторая' },
    ]);
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('sticker-n2') !== null);
    expect(screen.getByTestId('record-n2').props.accessibilityLabel).toMatch(/^Стикер 2 из 2/);
    await fireEvent.press(screen.getByTestId('record-menu-n2'));
    await fireEvent.press(screen.getByTestId('menu-pin'));
    // The pin is decoration (the label says «приколот»): hidden from screen readers.
    await settle(() => screen.queryByTestId('sticker-pin-n2', { includeHiddenElements: true }) !== null);
    expect(screen.getByTestId('record-n2').props.accessibilityLabel).toMatch(/^Стикер 1 из 2\. белый\. приколот/);
    expect(stripText()).toBe('Приколол: Вторая');
    expect(outbox.all().find((r) => r.kind === 'page.item_look')!.payload).toMatchObject({ pinned: true });
  });

  it('«раскрась по темам» from the line: colours of `page_patch.rows`, «Что изменилось», «Отменить»', async () => {
    const s = server();
    const seqd = (events: Omit<SseEvent, 'id'>[]): SseEvent[] => events.map((e, i) => ({ ...e, id: i + 1 }));
    const paint = action('apaint', 'Раскрасил 2 стикера по темам: Ремонт — жёлтый.', {
      initiated_by: 'agent',
      page: { id: 'srv-notes', title: 'Заметки', icon: 'documents' },
      changes: [
        { item_id: 'srv-n1', key: null, kind: 'color', title: 'Плитка', text: 'Цвет: «Плитка» → жёлтый', page_id: 'srv-notes', reverted: false },
        { item_id: 'srv-n2', key: null, kind: 'color', title: 'Грунтовка', text: 'Цвет: «Грунтовка» → жёлтый', page_id: 'srv-notes', reverted: false },
      ],
    });
    const painted = (id: string, seq: number) => linkOut('srv-notes', id, seq, { position: id === 'srv-n1' ? 'U' : 'V', appearance: { color: 'yellow', color_set_by: 'agent' } });
    s.on('POST /chat/messages', () => ({
      status: 200,
      sse: seqd([
        { event: 'accepted', data: { message_id: 'u1', reply_id: 'r1', created_at: iso(t0()) } },
        { event: 'action', data: { reply_id: 'r1', action: paint, changed_item_ids: ['srv-n1', 'srv-n2'], page_id: 'srv-notes' } },
        { event: 'page_patch', data: { page_id: 'srv-notes', view_version: 6, view_state: {}, rows: [painted('srv-n1', 90), painted('srv-n2', 91)], removed_item_ids: [] } },
        { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'action', action_id: 'apaint', delivery: 'streamed', limited: false } },
      ]),
    }));
    await online(s);
    const notes = await serverPage('notes', [
      { id: 'n1', text: 'Плитка' },
      { id: 'n2', text: 'Грунтовка' },
    ]);
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('sticker-n1') !== null);
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'раскрась по темам');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => bg('sticker-n1') === lightNoteColors.yellow && bg('sticker-n2') === lightNoteColors.yellow);
    expect(within(screen.getByTestId('undo-strip')).getByText('Раскрасил 2 стикера по темам: Ремонт — жёлтый.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/apaint/undo').length === 1);
  });

  it('≥150%: one column, the colour is a band on paper; empty: an example sticker', async () => {
    Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 2 }, screen: { width: 390, height: 844, scale: 3, fontScale: 2 } });
    const s = server();
    await online(s);
    s.offline = true;
    const notes = await serverPage('notes', [{ id: 'n1', text: 'Код', link: { appearance: { color: 'pink' } } }]);
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('sticker-band-n1') !== null);
    expect(bg('sticker-band-n1')).toBe(lightNoteColors.pink);
    expect(bg('sticker-n1')).toBe('#FFFDF8');
  });
});

describe('«Дела» — the day planner', () => {
  it('a reminder at its hour with «Сейчас»; its row is not among «Без времени»; «⋯ → +15 минут» moves it with «Отменить»', async () => {
    const s = server();
    const outbox = await online(s);
    s.offline = true;
    const now = t0();
    const startTomorrow = new Date(now);
    startTomorrow.setHours(24, 0, 0, 0);
    // Later today when there is time left, else a missed-free slot just before midnight is not possible: skip.
    const at = Math.min(now + 30 * MIN, startTomorrow.getTime() - MIN);
    const tasks = await serverPage('tasks', [
      { id: 'd1', text: 'Таблетка маме' },
      { id: 'd2', text: 'Оплатить свет' },
    ]);
    const r = reminderOut({ id: 'r1', title: 'Таблетка маме', due_at: iso(at), kind: 'normal', status: 'scheduled', level: 'alarm', version: 2, offsets: [], item_id: 'srv-d1' })!;
    const f = fireOut({ id: 'f1', reminder_id: 'r1', key: 'r1:k:0:0', occurrence_at: iso(at), fire_at: iso(at), offset_min: 0, snooze_n: 0, state: 'planned' })!;
    useAlarms.setState({ reminders: { r1: r }, fires: { [f.key]: f } });
    useTasks.setState({
      tasks: {
        t1: task('t1', { list_key: 'todo', title: 'Таблетка маме', item_id: 'srv-d1' }),
        t2: task('t2', { list_key: 'todo', title: 'Оплатить свет', item_id: 'srv-d2' }),
      },
    });
    await renderRouter(APP_DIR, { initialUrl: `/page/${tasks.id}` });
    await settle(() => screen.queryByTestId('rem-r1:k:0:0') !== null);
    expect(screen.getByTestId('page-view-tasks:builtin:planner')).toBeTruthy();
    expect(screen.getByTestId('planner-now')).toBeTruthy();
    expect(screen.getByTestId('rem-r1:k:0:0').props.accessibilityLabel).toMatch(/Будильник\. Таблетка маме/);
    // The timed row is in its hour (its box there), the other one under «Без времени».
    expect(screen.getByTestId('group-untimed')).toHaveTextContent('Без времени');
    expect(screen.getAllByTestId('task-t1')).toHaveLength(1);
    expect(screen.queryByTestId('record-menu-d1')).toBeNull();
    expect(screen.getByTestId('task-t2')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('rem-menu-r1:k:0:0'));
    await fireEvent.press(screen.getByTestId('slot-plus15'));
    await settle(() => outbox.all().some((x) => x.kind === 'reminder.update'));
    const upd = outbox.all().find((x) => x.kind === 'reminder.update')!;
    expect((upd.payload as { body: { due_at: string } }).body.due_at).toBe(iso(at + 15 * MIN));
    expect(stripText()).toMatch(/^Перенёс: Таблетка маме на /);
  });

  it('a tick in its place offline with «Отменить»; overdue to-dos are red under «Пропущено»', async () => {
    const s = server();
    await online(s);
    s.offline = true;
    const tasks = await serverPage('tasks', [
      { id: 'd2', text: 'Оплатить свет' },
      { id: 'd3', text: 'Записаться к врачу' },
    ]);
    useTasks.setState({
      tasks: {
        t2: task('t2', { list_key: 'todo', title: 'Оплатить свет', item_id: 'srv-d2' }),
        t3: task('t3', { list_key: 'todo', title: 'Записаться к врачу', item_id: 'srv-d3', due_date: '2020-01-02' }),
      },
    });
    await renderRouter(APP_DIR, { initialUrl: `/page/${tasks.id}` });
    await settle(() => screen.queryByTestId('task-t2') !== null);
    expect(screen.queryByTestId('task-t3')).toBeNull();
    expect(screen.getByTestId('seg-missed')).toHaveTextContent('Пропущено (1)');
    await fireEvent.press(screen.getByTestId('task-t2'));
    await settle(() => screen.queryByTestId('group-done') !== null);
    expect(screen.getByTestId('group-done')).toHaveTextContent('Сделано (1)');
    expect(stripText()).toBeTruthy();
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => screen.queryByTestId('group-done') === null);
    await fireEvent.press(screen.getByTestId('seg-missed'));
    await settle(() => screen.queryByTestId('task-t3') !== null);
    expect(within(screen.getByTestId('task-t3')).getByText(/Просрочено/)).toBeTruthy();
  });
});

describe('«Покупки» — the fridge list and «Я в магазине»', () => {
  async function shopPage(s: FakeServer) {
    const outbox = await online(s);
    const shop = await serverPage('shopping', [
      { id: 's1', text: 'Молоко' },
      { id: 's2', text: 'Хлеб' },
      { id: 's3', text: 'Яйца' },
    ]);
    useTasks.setState({
      tasks: {
        m: task('m', { title: 'Молоко', item_id: 'srv-s1', qty: '2', where: 'Магнум' }),
        h: task('h', { title: 'Хлеб', item_id: 'srv-s2' }),
        y: task('y', { title: 'Яйца', item_id: 'srv-s3', done: true, done_at: iso(t0()) }),
      },
    });
    return { outbox, shop };
  }

  it('«Осталось 2 из 3»; «− 2 +» at once and as PATCH /tasks with `version`; «Убрать все купленные» is one call, one «Отменить»', async () => {
    const s = server();
    s.on('PATCH /tasks/*', (c) => ({ status: 200, body: { task: task('m', { title: 'Молоко', item_id: 'srv-s1', qty: (c.body as { qty: string }).qty, version: 4, seq: 50 }), action: action('aqty', 'Изменил: молоко') } }))
      .on('POST /tasks/clear-done', () => ({ status: 200, body: { tasks: [task('y', { deleted_at: iso(t0()), seq: 60, done: true })], action: action('aclr', 'Убрал купленное: яйца.'), page_patches: [], repeated: false } }));
    const { outbox, shop } = await shopPage(s);
    await renderRouter(APP_DIR, { initialUrl: `/page/${shop.id}` });
    await settle(() => screen.queryByTestId('shop-left') !== null);
    expect(screen.getByTestId('page-view-shopping:builtin:shopping')).toBeTruthy();
    expect(screen.getByTestId('shop-left')).toHaveTextContent('Осталось 2 из 3');
    expect(screen.getByTestId('qty-m')).toHaveTextContent('2');
    await fireEvent.press(screen.getByTestId('qty-plus-m'));
    await settle(() => screen.getByTestId('qty-m').props.children === '3');
    expect(stripText()).toBe('Молоко: 3');
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => s.callsTo('PATCH /tasks/m').length === 1);
    expect(s.callsTo('PATCH /tasks/m')[0]!.body).toEqual({ version: 3, qty: '3', client_id: expect.any(String) });

    expect(screen.getByTestId('group-done')).toHaveTextContent('Куплено (1)');
    await fireEvent.press(screen.getByTestId('shop-clear-bought'));
    await settle(() => screen.queryByTestId('task-y') === null);
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => s.callsTo('POST /tasks/clear-done').length === 1);
    expect(s.callsTo('POST /tasks/clear-done')[0]!.body).toMatchObject({ list_key: 'shopping', task_ids: ['y'] });
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => s.callsTo('POST /actions/aclr/undo').length === 1);
  });

  it('grouped by «Где купить» with the person\'s order; «Порядок» ↑ sends `group_order`', async () => {
    const s = server();
    const { outbox, shop } = await shopPage(s);
    useTasks.setState((st) => ({ tasks: { ...st.tasks, h: { ...st.tasks.h!, where: 'Аптека' } } }));
    const look = { layout: 'builtin:shopping' as const, icon: shop.icon, view: { ...EMPTY_VIEW, groupBy: 'where' } };
    await testPages.setLook(shop.id, look, false);
    await act(async () => usePages.getState().setLook(shop.id, look));
    await renderRouter(APP_DIR, { initialUrl: `/page/${shop.id}` });
    await settle(() => screen.queryByTestId('group-where:Магнум') !== null);
    await fireEvent.press(screen.getByTestId('page-order'));
    await settle(() => screen.queryByTestId('group-up-Аптека') !== null);
    await fireEvent.press(screen.getByTestId('group-up-Аптека'));
    await settle(() => outbox.all().some((r) => r.kind === 'page.view'));
    expect(pageOf('shopping').view?.groupOrder).toEqual(['Аптека', 'Магнум']);
  });

  it('«Я в магазине»: big rows, the line folds to chip + mic, no tabs; a tick offline at once; «Выйти»', async () => {
    const s = server();
    await shopPage(s);
    s.offline = true;
    await renderRouter(APP_DIR, { initialUrl: `/page/${pageOf('shopping').id}` });
    await settle(() => screen.queryByTestId('shop-mode') !== null);
    await fireEvent.press(screen.getByTestId('shop-mode'));
    await settle(() => screen.queryByTestId('shop-mode-screen') !== null);
    expect(useView.getState().shopMode).toBe(pageOf('shopping').id);
    expect(screen.getByTestId('assistant-line-folded')).toBeTruthy();
    expect(screen.queryByTestId('assistant-input')).toBeNull();
    expect(screen.queryByTestId('page-title')).toBeNull();
    expect(screen.getByTestId('shop-mode-left')).toHaveTextContent('Осталось 2');
    expect(screen.getByText('Молоко  ×2')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('task-h'));
    await settle(() => screen.queryByTestId('task-h') === null);
    expect(screen.getByTestId('shop-mode-left')).toHaveTextContent('Осталось 1');
    await fireEvent.press(screen.getByTestId('shop-exit'));
    await settle(() => screen.queryByTestId('shop-left') !== null);
    expect(useView.getState().shopMode).toBeNull();
    expect(screen.getByTestId('assistant-input')).toBeTruthy();
  });
});
