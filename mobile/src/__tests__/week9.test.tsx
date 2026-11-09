import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { missedRows } from '@/alarms/service';
import { useAlarms } from '@/alarms/store';
import { actionOut, decodeChatEvent, fireOut, reminderOut, taskOut, todayOut } from '@/api/endpoints';
import type { FireOut, ReminderOut, TaskOut } from '@/api/types';
import type { InMemoryOutboxRepository } from '@/db';
import { getSyncEngine } from '@/services';
import { usePages } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { removePage, undoManual } from '@/pages/manual';
import { listRows } from '@/tasks/rows';
import { addTask, isDone, setDone } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { useToday } from '@/today/service';
import { happyServer, type FakeServer, type SseEvent } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages } from '@/testing/helpers';

/**
 * Week 9 (docs/api/today.md, actions.md, reminders.md «From the assistant line», pages.md):
 * «Сегодня», «Дела» and «Покупки» as checklists, S20, S30, tasks and reminders from the line.
 * Fake server only: nothing here ran against the real server or on a phone.
 */

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function task(id: string, extra: Partial<TaskOut> = {}): TaskOut {
  return taskOut({
    id,
    client_id: `c-${id}`,
    item_id: `srv-i-${id}`,
    list_key: 'shopping',
    title: id,
    qty: null,
    where: null,
    due_date: null,
    done: false,
    done_at: null,
    version: 1,
    seq: 1,
    created_at: iso(Date.now()),
    updated_at: iso(Date.now()),
    deleted_at: null,
    ...extra,
  })!;
}

function action(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'save_item',
    scope: 'internal',
    initiated_by: 'agent',
    summary: { ru: summary, kk: null },
    page: null,
    changes: [],
    changed_item_ids: [],
    created_page_id: null,
    undoable: true,
    undoable_until: iso(Date.now() + 30 * 86_400_000),
    undone_at: null,
    undo_of: null,
    message_id: null,
    seq: 10,
    created_at: iso(Date.now() - MIN),
    ...extra,
  };
}

type Srv = FakeServer & { tasks: Map<string, TaskOut>; seq: number };

/** happyServer + tasks, today, actions, habits, suggestions as the contract says. */
function server(): Srv {
  const s = happyServer() as Srv;
  s.tasks = new Map();
  s.seq = 1000;
  s.on('POST /tasks', (c) => {
    const b = c.body as { client_id: string; list_key: 'todo' | 'shopping'; title: string };
    const t = task(`t-${b.client_id}`, { client_id: b.client_id, list_key: b.list_key, title: b.title, seq: ++s.seq });
    s.tasks.set(t.id, t);
    return { status: 201, body: { task: t, action: action(`a-${t.id}`, `Добавил в Покупки: ${b.title}.`), page_patches: [], repeated: false } };
  })
    .on('POST /tasks/*/done', (c) => {
      const id = c.path.split('/')[2]!;
      const done = (c.body as { done: boolean }).done;
      const t = { ...(s.tasks.get(id) ?? task(id)), done, done_at: done ? iso(Date.now()) : null, seq: ++s.seq };
      s.tasks.set(id, t);
      return { status: 200, body: { task: t, action: action(`a-done-${s.seq}`, done ? `Купил: ${t.title}` : `Вернул: ${t.title}`, { initiated_by: 'user' }), repeated: false } };
    })
    .on('POST /actions/*/undo', (c) => ({
      status: 200,
      body: { action: { ...action(c.path.split('/')[2]!, 'x'), undoable: false, undone_at: iso(Date.now()) }, undo: null, partial: false, repeated: false, message_ru: null, page_patches: [] },
    }))
    .on('GET /today', () => ({ status: 200, body: { sections: [], today: { reminders: [], tasks: [], shopping: null }, missed: [], done_for_you: { actions: [], count_today: 0 }, proposals: [], tip: null, empty: false } }))
    .on('GET /actions', () => ({ status: 200, body: { actions: [], has_more: false } }));
  return s;
}

async function online(s: Srv, mode: 'full' | 'no_ai' = 'full'): Promise<InMemoryOutboxRepository> {
  const outbox = resetApp({ fetch: s.fetch });
  finishOnboarding(mode);
  usePages.getState().addPage('shopping');
  await (await getSyncEngine()).run();
  return outbox;
}

async function sync(outbox: InMemoryOutboxRepository) {
  const e = await getSyncEngine();
  await e.whenIdle();
  for (const r of outbox.all()) if (r.status === 'pending') await outbox.markRetry(r.id, 'test', 0);
  await e.run();
}

const page = (key: string) => usePages.getState().pages.find((p) => p.templateKey === key)!;

describe('contract decoding (today.md, actions.md)', () => {
  it('Task, /today, an action row without a record, the chat events of week 9', () => {
    const t = taskOut({ id: 't1', list_key: 'shopping', title: 'Хлеб', qty: '2', done: true, done_at: '2026-11-08T10:00:00Z', version: 3, seq: 9 });
    expect(t).toMatchObject({ list_key: 'shopping', qty: '2', done: true, version: 3 });
    const today = todayOut({
      date: '2026-11-08',
      greeting: 'Добрый день',
      sections: ['missed', 'today', 'tip'],
      today: { reminders: [], tasks: [t], shopping: { page_id: 'p', count: 3, titles: ['Хлеб'] } },
      missed: [],
      done_for_you: { actions: [action('a1', 'Записал.')], count_today: 1 },
      banner: null,
      proposals: [1, 2, 3].map((n) => ({ id: `s${n}`, kind: 'data_proposal', key: 'task_from_item', text_ru: `П${n}`, yes_label: 'Да', no_label: 'Не сейчас', do: {}, status: 'shown' })),
      tip: { id: 'tip', kind: 'tip', key: 'open', text_ru: 'Скажите…', yes_label: 'Попробовать', no_label: 'Не сейчас', do: { type: 'open_mic' }, status: 'shown' },
      empty: false,
    });
    expect(today.proposals).toHaveLength(2);
    expect(today.tip?.do?.type).toBe('open_mic');
    expect(today.today.shopping?.count).toBe(3);
    expect(today.done_for_you.actions[0]?.initiated_by).toBe('agent');
    const a = actionOut(action('a2', 'Напомню завтра', { changes: [{ item_id: null, reminder_id: 'r1', title: 'x', kind: 'reminder', text: 'Напоминание', page_id: null, reverted: false }] }));
    expect(a?.changes[0]).toMatchObject({ item_id: null, reminder_id: 'r1', text: 'Напоминание' });
    const ev = decodeChatEvent({ event: 'action', data: JSON.stringify({ reply_id: 'r', action: action('a3', 'Добавил'), changed_item_ids: [], tasks: [t] }), id: '1' });
    expect(ev?.type === 'action' && ev.tasks?.[0]?.title).toBe('Хлеб');
    const rd = decodeChatEvent({
      event: 'reminder_draft',
      data: JSON.stringify({ reply_id: 'r9', status: 'ok', draft: { title: 'Выпить таблетку', due_at: '2026-11-09T02:00:00Z', level: 'alarm' }, options: [], created_via: 'voice' }),
      id: '2',
    });
    expect(rd).toMatchObject({ type: 'reminder_draft', replyId: 'r9', createdVia: 'voice', draft: { status: 'ok', draft: { title: 'Выпить таблетку' } } });
  });
});

describe('list rows (pure)', () => {
  it('page order kept for open rows; done ones at the bottom, newest ticked first; a task without a row first', () => {
    const recs = ['a', 'b', 'c'].map((id) => ({ record: { id, serverId: `srv-i-${id}` }, link: null }) as never);
    const ts = [
      task('a'),
      task('b', { done: true, done_at: iso(Date.now() - 2 * MIN) }),
      task('c', { done: true, done_at: iso(Date.now() - MIN) }),
      task('d', { item_id: null }),
      task('e', { list_key: 'todo', item_id: null }),
    ];
    const out = listRows(recs, ts, {}, { lists: ['shopping'], today: '2026-11-08' });
    expect(out.open.map((r) => r.task?.id)).toEqual(['d', 'a']);
    expect(out.done.map((r) => r.task?.id)).toEqual(['c', 'b']);
    // A tick on the phone wins over the server's copy.
    const ticked = listRows(recs, ts, { a: { done: true, at: iso(Date.now()) } }, { lists: ['shopping'], today: '2026-11-08' });
    expect(ticked.done.map((r) => r.task?.id)).toEqual(['a', 'c', 'b']);
  });

  it('«Дела»: Сегодня = no day or due today/overdue; Скоро = later days; done only under Сегодня', () => {
    const ts = [
      task('x', { list_key: 'todo', item_id: null, due_date: '2026-11-07' }),
      task('y', { list_key: 'todo', item_id: null, due_date: '2026-11-10' }),
      task('z', { list_key: 'todo', item_id: null, done: true }),
    ];
    const o = { lists: ['todo' as const], today: '2026-11-08' };
    expect(listRows([], ts, {}, { ...o, segment: 'today' }).open.map((r) => r.task?.id)).toEqual(['x']);
    expect(listRows([], ts, {}, { ...o, segment: 'soon' }).open.map((r) => r.task?.id)).toEqual(['y']);
    expect(listRows([], ts, {}, { ...o, segment: 'soon' }).done).toEqual([]);
    expect(listRows([], ts, {}, { ...o, segment: 'today' }).done.map((r) => r.task?.id)).toEqual(['z']);
  });
});

describe('missed rows (pure)', () => {
  const now = Date.parse('2026-11-08T10:00:00Z');
  const r = reminderOut({ id: 'r1', title: 'Позвонить Ерлану', due_at: iso(now - 60 * MIN), kind: 'normal', status: 'scheduled', level: 'alarm' }) as ReminderOut;
  const f = (extra: Partial<FireOut>) =>
    fireOut({ id: 'f', reminder_id: 'r1', key: 'k0', occurrence_at: r.due_at, fire_at: r.due_at, offset_min: 0, snooze_n: 0, state: 'planned', ...extra }) as FireOut;

  it('the server\'s `missed`, or +30 min with no answer here (offline); answered or moved ones are not rows', () => {
    const base = { reminders: { r1: r }, local: {} };
    expect(missedRows({ ...base, fires: { k0: f({ state: 'missed' }) } }, [], now).map((x) => x.title)).toEqual(['Позвонить Ерлану']);
    expect(missedRows({ ...base, fires: { k0: f({ state: 'fired' }) } }, [], now)).toHaveLength(1);
    expect(missedRows({ ...base, fires: { k0: f({ state: 'fired', fire_at: iso(now - 10 * MIN) }) } }, [], now)).toHaveLength(0);
    expect(missedRows({ ...base, fires: { k0: f({ state: 'missed' }) }, local: { k0: { ackedAt: now } } }, [], now)).toHaveLength(0);
    expect(missedRows({ ...base, fires: { k0: f({ state: 'missed' }) } }, ['k0'], now)).toHaveLength(0);
    expect(missedRows({ ...base, fires: { k1: f({ key: 'k1', state: 'missed', offset_min: 60 }) } }, [], now)).toHaveLength(0);
  });
});

describe('ticks and rows by hand (offline-first)', () => {
  it('a tick offline shows at once, a stale sync does not undo it, it goes as POST /tasks/{id}/done', async () => {
    const s = server();
    const outbox = await online(s);
    const t = task('t1', { title: 'Хлеб' });
    s.tasks.set(t.id, t);
    s.on('GET /sync', () => ({ status: 200, body: { tasks: [t], next_since: 2000, has_more: false } }));
    await sync(outbox);
    expect(useTasks.getState().tasks.t1?.done).toBe(false);
    s.offline = true;
    await setDone('t1', true);
    expect(useTasks.getState().ticks.t1?.done).toBe(true);
    expect(useUndo.getState().strip).toMatchObject({ kind: 'custom', text: 'Купил: Хлеб' });
    expect(outbox.all().filter((r) => r.kind === 'task.update' && r.status === 'pending')).toHaveLength(1);
    s.offline = false;
    // The server's copy still says «not bought» in this sync: the tick stays.
    s.on('POST /tasks/*/done', () => 'offline');
    await sync(outbox);
    expect(useTasks.getState().ticks.t1?.done).toBe(true);
    s.on('POST /tasks/*/done', (c) => ({ status: 200, body: { task: { ...t, done: true, seq: 3000 }, action: action('ad', 'Купил: Хлеб', { initiated_by: 'user' }) } }));
    s.on('GET /sync', () => ({ status: 200, body: { next_since: 2000, has_more: false } }));
    await sync(outbox);
    const call = s.callsTo('POST /tasks/t1/done').at(-1);
    expect(call?.body).toMatchObject({ done: true, client_id: expect.any(String) });
    expect(useTasks.getState().ticks.t1).toBeUndefined();
    expect(useTasks.getState().tasks.t1?.done).toBe(true);
    expect(useTasks.getState().actions.ad).toBeDefined(); // «Что я сделал» has the tick (US-10)
  });

  it('a row added offline, «Отменить» before it went: nothing is sent; another one goes as POST /tasks and becomes the server\'s', async () => {
    const s = server();
    const outbox = await online(s);
    s.offline = true;
    await addTask({ list: 'shopping', title: 'Молоко' });
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'custom') throw new Error('no strip');
    expect(strip.text).toBe('Добавил в Покупки: Молоко');
    expect(strip.openPageId).toBe(page('shopping').id);
    strip.onUndo();
    await settle(() => outbox.all().some((r) => r.kind === 'task.create' && r.status === 'failed'));
    await addTask({ list: 'shopping', title: 'Хлеб' });
    s.offline = false;
    await sync(outbox);
    expect(s.callsTo('POST /tasks').map((c) => (c.body as { title: string }).title)).toEqual(['Хлеб']);
    const live = Object.values(useTasks.getState().tasks).filter((t) => !t.deleted_at);
    expect(live.map((t) => [t.title, t.id.startsWith('local:')])).toEqual([['Хлеб', false]]);
  });
});

function chatReply(events: Omit<SseEvent, 'id'>[]): SseEvent[] {
  return events.map((e, i) => ({ ...e, id: i + 1 }));
}

describe('screens', () => {
  it('«Покупки» offline: the phrase is a row with a box, ticked it goes down grey with «Вернуть»', async () => {
    const s = server();
    await online(s);
    s.offline = true;
    const shop = page('shopping');
    await renderRouter(APP_DIR, { initialUrl: `/page/${shop.id}` });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'хлеб');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => Object.values(useTasks.getState().tasks).length === 1);
    const t = Object.values(useTasks.getState().tasks)[0]!;
    await settle(() => screen.queryByTestId(`task-${t.id}`) !== null);
    expect(s.callsTo('POST /chat/messages')).toHaveLength(0);
    expect(screen.getByTestId(`task-${t.id}`).props.accessibilityState).toEqual({ checked: false });
    await fireEvent.press(screen.getByTestId(`task-${t.id}`));
    await settle(() => screen.queryByTestId(`task-return-${t.id}`) !== null);
    expect(screen.getByTestId('group-done')).toHaveTextContent('Куплено (1)'); // week 11а: «Куплено (N)»
    await fireEvent.press(screen.getByTestId(`task-return-${t.id}`));
    await settle(() => screen.queryByTestId(`task-return-${t.id}`) === null);
  });

  it('online on any page the phrase goes to chat; the tasks of the action show on «Покупки» at once with [Открыть]', async () => {
    const s = server();
    await online(s);
    const t = task('srv-t9', { title: 'Молоко', item_id: 'srv-i9' });
    const act0 = action('a9', 'Добавил в Покупки: молоко.', { page: { id: 'srv-shop', title: 'Покупки', icon: 'shopping' } });
    s.on('POST /chat/messages', () => ({
      status: 200,
      sse: chatReply([
        { event: 'accepted', data: { message_id: 'u1', reply_id: 'r1' } },
        { event: 'action', data: { reply_id: 'r1', action: act0, changed_item_ids: [], tasks: [t] } },
        { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'action', action_id: 'a9', limited: false } },
      ]),
    }));
    usePages.setState((st) => ({ pages: st.pages.map((p) => (p.templateKey === 'shopping' ? { ...p, serverId: 'srv-shop' } : p)) }));
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'купить молоко');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => screen.queryByTestId('undo-strip-open') !== null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Добавил в Покупки: молоко.');
    expect(useTasks.getState().tasks['srv-t9']?.title).toBe('Молоко');
    await fireEvent.press(screen.getByTestId('undo-strip-open'));
    await settle(() => r.getPathname() === `/page/${page('shopping').id}`);
    await settle(() => screen.queryByTestId('task-srv-t9') !== null);
  });

  it('a reminder phrase online goes to chat (not /reminders/parse): `reminder_draft` opens S13, [Сохранить] sends its `message_id`', async () => {
    const s = server();
    await online(s);
    s.on('POST /reminders/active', () => ({ status: 200, body: { device_id: 'd-1', retargeted: 0 } }))
      .on('POST /reminders', (c) => ({ status: 201, body: { reminder: null, fires: [], action: action('ar', 'Напомню завтра в 7:00: выпить таблетку', { initiated_by: 'user', kind: 'create_reminder' }), _b: c.body } }))
      .on('POST /chat/messages', () => ({
        status: 200,
        sse: chatReply([
          { event: 'accepted', data: { message_id: 'u1', reply_id: 'r5' } },
          {
            event: 'reminder_draft',
            data: { reply_id: 'r5', status: 'ok', source: 'llm', draft: { title: 'Выпить таблетку', due_at: iso(Date.now() + 20 * 60 * MIN), tz: 'Asia/Almaty', offsets: [], level: 'notification' }, options: [], parser: 'llm', created_via: 'typed' },
          },
          { event: 'banner', data: { reply_id: 'r5', text: 'Понял так: …', preview: 'Понял так: …', short: true, ai_label: null, citations: [] } },
          { event: 'done', data: { reply_id: 'r5', state: 'done', answer_kind: 'text', limited: false } },
        ]),
      }));
    useAlarms.setState({ notifyAskedAt: iso(Date.now()) });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Напомни завтра в 7 выпить таблетку');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => r.getPathname() === '/reminder-new');
    expect(s.callsTo('POST /reminders/parse')).toHaveLength(0);
    expect(screen.getByTestId('rem-title').props.value).toBe('Выпить таблетку');
    await fireEvent.press(screen.getByTestId('rem-save'));
    await settle(() => s.callsTo('POST /reminders').length > 0);
    expect(s.callsTo('POST /reminders')[0]?.body).toMatchObject({ message_id: 'r5', created_via: 'typed' });
    await settle(() => !!useTasks.getState().actions.ar); // «Что я сделал» has it, with «Отменить»
  });

  it('«Сегодня»: a missed alarm is a red row; [Сделано] is a late `acked` (offline too) and the row goes', async () => {
    const s = server();
    const outbox = await online(s);
    const due = Date.now() - 60 * MIN;
    const r = reminderOut({ id: 'r1', title: 'Позвонить Ерлану', due_at: iso(due), kind: 'normal', status: 'scheduled', level: 'alarm', version: 1 })!;
    const f = fireOut({ id: 'f1', reminder_id: 'r1', key: 'r1:k:0:0', occurrence_at: iso(due), fire_at: iso(due), offset_min: 0, snooze_n: 0, state: 'missed' })!;
    useAlarms.setState({ reminders: { r1: r }, fires: { [f.key]: f } });
    s.offline = true;
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId(`missed-${f.key}`) !== null);
    expect(screen.getByTestId(`missed-${f.key}`)).toHaveTextContent(/Пропущено .* · Позвонить Ерлану/);
    await fireEvent.press(screen.getByTestId(`missed-done-${f.key}`));
    await settle(() => screen.queryByTestId(`missed-${f.key}`) === null);
    const row = outbox.all().find((x) => x.kind === 'reminder.events');
    expect((row?.payload as { events: { event: string; fire_id: string }[] }).events[0]).toMatchObject({ event: 'acked', fire_id: 'f1' });
  });

  it('«Сегодня»: shopping summary, a proposal from /today with [Не сейчас], «Я сделал за вас» with «Отменить», «Что я сделал ›»', async () => {
    const s = server();
    await online(s);
    useTasks.setState({ tasks: { a: task('a', { title: 'Хлеб' }), b: task('b', { title: 'Молоко' }) } });
    s.on('POST /suggestions/*/dismiss', () => ({ status: 200, body: { suggestion: {} } }));
    s.on('GET /today', () => ({
      status: 200,
      body: {
        sections: ['today', 'done_for_you', 'proposals'],
        today: { reminders: [], tasks: [], shopping: null },
        missed: [],
        done_for_you: { actions: [action('a1', 'Записал: код домофона.')], count_today: 1 },
        proposals: [{ id: 's1', kind: 'data_proposal', key: 'task_from_item', text_ru: 'Добавить в дела: «Оплатить свет»?', yes_label: 'Да, добавить', no_label: 'Не сейчас', do: { type: 'accept' }, status: 'shown' }],
        tip: null,
        empty: false,
      },
    }));
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('suggestion-s1') !== null);
    expect(screen.getByTestId('today-shopping')).toHaveTextContent('Покупки: Хлеб, Молоко (2)');
    expect(screen.getByTestId('suggestion-yes-s1')).toHaveTextContent('Да, добавить');
    await fireEvent.press(screen.getByTestId('suggestion-no-s1'));
    await settle(() => screen.queryByTestId('suggestion-s1') === null);
    expect(s.callsTo('POST /suggestions/s1/dismiss')).toHaveLength(1);
    expect(screen.getByTestId('did-today-a1')).toHaveTextContent(/^Записал: код домофона\./);
    await fireEvent.press(screen.getByTestId('did-today-undo-a1'));
    await settle(() => s.callsTo('POST /actions/a1/undo').length === 1);
    await settle(() => screen.queryByTestId('did-today-a1') === null);
    await fireEvent.press(screen.getByTestId('today-did-all'));
    await settle(() => r.getPathname() === '/did');
    expect(screen.getByTestId('did-a1')).toBeTruthy();
  });

  it('S30: the rules from the server, [Убрать] → DELETE /habits/{id}, «Отменить» = undo of its action', async () => {
    const s = server();
    await online(s);
    s.on('GET /habits', () => ({
      status: 200,
      body: { habits: [{ id: 'h1', kind: 'placement_rule', text_ru: 'Чеки кладу на страницу «Расходы»', page: { id: 'p', title: 'Расходы', icon: 'money' }, envelope_type: 'receipt', evidence_count: 2, updated_at: iso(Date.now()) }] },
    })).on('DELETE /habits/*', () => ({ status: 200, body: { removed: true, repeated: false, action: action('ah', 'Больше не кладу чеки в «Расходы»', { kind: 'habit_change', initiated_by: 'user' }) } }));
    await renderRouter(APP_DIR, { initialUrl: '/habits' });
    await settle(() => screen.queryByTestId('habit-h1') !== null);
    await fireEvent.press(screen.getByTestId('habit-remove-h1'));
    await settle(() => s.callsTo('DELETE /habits/h1').length === 1);
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'custom') throw new Error('no strip');
    expect(strip.text).toBe('Больше не кладу чеки в «Расходы»');
    await act(async () => strip.onUndo());
    await settle(() => s.callsTo('POST /actions/ah/undo').length === 1);
  });
});

describe('«Убрать страницу» undo (pages.md week 9)', () => {
  it('the removal came back with an action: «Отменить» is POST /actions/{id}/undo, not /restore', async () => {
    const s = server();
    const outbox = await online(s);
    const tasksPage = page('tasks');
    usePages.setState((st) => ({ pages: st.pages.map((p) => (p.id === tasksPage.id ? { ...p, serverId: 'srv-tasks', syncState: 'synced' as const } : p)) }));
    await testPages.insertLocal({ ...tasksPage, serverId: 'srv-tasks', syncState: 'synced' });
    s.on('DELETE /pages/*', () => ({
      status: 200,
      body: { id: 'srv-tasks', client_id: null, kind: 'page', template_key: 'tasks', title: 'Дела и напоминания', position: 'V', deleted_at: iso(Date.now()), seq: 5, action: action('apage', 'Страница «Дела» убрана. Записи остались', { kind: 'delete_screen', initiated_by: 'user' }) },
    }));
    await removePage(tasksPage.id);
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'manual') throw new Error('no strip');
    await sync(outbox);
    expect(s.callsTo('DELETE /pages/srv-tasks')).toHaveLength(1);
    await undoManual(strip.outboxIds);
    await sync(outbox);
    expect(s.callsTo('POST /actions/apage/undo')).toHaveLength(1);
    expect(s.callsTo('POST /pages/srv-tasks/restore')).toHaveLength(0);
    expect(usePages.getState().pages.some((p) => p.id === tasksPage.id)).toBe(true);
  });
});

describe('final contract (week 9 backend)', () => {
  it('«Отменить» of a tick after it went is the undo of the tick action, not another tap', async () => {
    const s = server();
    const outbox = await online(s);
    const t = task('t2', { title: 'Хлеб' });
    s.tasks.set(t.id, t);
    s.on('GET /sync', () => ({ status: 200, body: { tasks: [t], next_since: 2000, has_more: false } }));
    await sync(outbox);
    s.on('POST /tasks/*/done', () => ({ status: 200, body: { task: { ...t, done: true, seq: 3000 }, action: action('atick', 'Купил: Хлеб', { initiated_by: 'user', kind: 'facet_edit' }) } }));
    await setDone('t2', true);
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'custom') throw new Error('no strip');
    await sync(outbox);
    expect(useTasks.getState().tasks.t2?.done).toBe(true);
    await act(async () => strip.onUndo());
    await settle(() => s.callsTo('POST /actions/atick/undo').length === 1);
    expect(s.callsTo('POST /tasks/t2/done')).toHaveLength(1); // no second tap
    const st = useTasks.getState();
    expect(isDone(st.tasks.t2!, st.ticks)).toBe(false); // shown back at once
  });

  it('a late «Сделано» that went: «Отменить» undoes the action from the events answer', async () => {
    const s = server();
    const outbox = await online(s);
    const due = Date.now() - 60 * MIN;
    const r = reminderOut({ id: 'r7', title: 'Свет', due_at: iso(due), kind: 'normal', status: 'scheduled', level: 'alarm', version: 1 })!;
    const f = fireOut({ id: 'f7', reminder_id: 'r7', key: 'r7:k:0:0', occurrence_at: iso(due), fire_at: iso(due), offset_min: 0, snooze_n: 0, state: 'missed' })!;
    useAlarms.setState({ reminders: { r7: r }, fires: { [f.key]: f } });
    s.on('POST /reminders/events', (c) => ({
      status: 200,
      body: {
        results: (c.body as { events: { client_id: string }[] }).events.map((e) => ({ client_id: e.client_id, status: 'applied' })),
        fires: [],
        actions: [
          action('alate', 'Сделано: свет', {
            kind: 'edit_reminder',
            initiated_by: 'user',
            created_at: iso(Date.now()),
            // The explicit link (reminders.md): the action names the event that made it.
            event_client_id: (c.body as { events: { client_id: string }[] }).events[0]!.client_id,
            changes: [{ item_id: null, reminder_id: 'r7', title: 'Свет', kind: 'reminder', text: 'Свет', page_id: null, reverted: false }],
          }),
        ],
      },
    }));
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId(`missed-done-${f.key}`) !== null);
    await fireEvent.press(screen.getByTestId(`missed-done-${f.key}`));
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => s.callsTo('POST /reminders/events').length > 0 && !!useTasks.getState().actions.alate);
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/alate/undo').length === 1);
    await settle(() => screen.queryByTestId(`missed-${f.key}`) !== null); // missed again
  });

  it('«Удалить» a reminder on «Дела»: DELETE answers 200 with an action; «Отменить» undoes it', async () => {
    const s = server();
    const outbox = await online(s);
    s.on('POST /reminders/active', () => ({ status: 200, body: { device_id: 'd-1', retargeted: 0 } }))
      .on('GET /reminders/fires', () => ({ status: 200, body: { device_id: 'd-1', fires: [], reminders: [] } }))
      .on('DELETE /reminders/*', () => ({ status: 200, body: { reminder: null, fires: [], action: action('adel', 'Удалил напоминание «Свет»', { kind: 'edit_reminder', initiated_by: 'user' }) } }));
    const due = Date.now() + 60 * MIN;
    const r = reminderOut({ id: 'r8', title: 'Свет', due_at: iso(due), kind: 'normal', status: 'scheduled', level: 'notification', version: 1 })!;
    const f = fireOut({ id: 'f8', reminder_id: 'r8', key: 'r8:k:0:0', occurrence_at: iso(due), fire_at: iso(due), offset_min: 0, snooze_n: 0, state: 'planned' })!;
    useAlarms.setState({ reminders: { r8: r }, fires: { [f.key]: f } });
    await renderRouter(APP_DIR, { initialUrl: `/page/${page('tasks').id}` });
    // Week 11а planner: «Удалить» is in the reminder's «⋯» (with «Перенести время»).
    await settle(() => screen.queryByTestId(`rem-menu-${f.key}`) !== null);
    await fireEvent.press(screen.getByTestId(`rem-menu-${f.key}`));
    await settle(() => screen.queryByTestId(`rem-delete-${f.key}`) !== null);
    await fireEvent.press(screen.getByTestId(`rem-delete-${f.key}`));
    await settle(() => screen.queryByTestId(`rem-${f.key}`) === null);
    await act(async () => {
      await sync(outbox);
    });
    expect(s.callsTo('DELETE /reminders/r8')).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/adel/undo').length === 1);
  });

  it('S30 «Изменить» moves a learned rule (PATCH /habits/{id} with page_id); an exclusion has only «Убрать»', async () => {
    const s = server();
    await online(s);
    usePages.setState((st) => ({ pages: st.pages.map((p) => ({ ...p, serverId: `srv-${p.templateKey}` })) }));
    s.on('GET /habits', () => ({
      status: 200,
      body: {
        habits: [
          { id: 'h1', kind: 'placement_rule', text_ru: 'Чеки кладу на страницу «Расходы»', page: { id: 'srv-expenses', title: 'Расходы', icon: 'money' }, evidence_count: 2, updated_at: iso(Date.now()) },
          { id: 'x1', kind: 'screen_exclusion', text_ru: 'Не показываю «Хлеб» на странице «Заметки»', page: { id: 'srv-notes', title: 'Заметки', icon: 'documents' }, item_id: 'i', evidence_count: 1, updated_at: iso(Date.now()) },
        ],
      },
    })).on('PATCH /habits/*', () => ({ status: 200, body: { habit: null, action: action('amove', 'Теперь: чеки кладу на страницу «Покупки»', { kind: 'habit_change', initiated_by: 'user' }), repeated: false } }));
    await renderRouter(APP_DIR, { initialUrl: '/habits' });
    await settle(() => screen.queryByTestId('habit-x1') !== null);
    expect(screen.queryByTestId('habit-change-x1')).toBeNull();
    await fireEvent.press(screen.getByTestId('habit-change-h1'));
    const shop = page('shopping');
    await settle(() => screen.queryByTestId(`habit-page-${shop.id}`) !== null);
    expect(screen.queryByTestId(`habit-page-${page('expenses').id}`)).toBeNull();
    await fireEvent.press(screen.getByTestId(`habit-page-${shop.id}`));
    await settle(() => s.callsTo('PATCH /habits/h1').length === 1);
    expect(s.callsTo('PATCH /habits/h1')[0]?.body).toMatchObject({ page_id: 'srv-shopping', client_id: expect.any(String) });
    await settle(() => useUndo.getState().strip?.kind === 'custom');
  });

  it('/sync `suggestions` hide an answered one; `habits` keep learned rules for S30 offline', async () => {
    const s = server();
    const outbox = await online(s);
    s.on('GET /sync', () => ({
      status: 200,
      body: {
        suggestions: [{ id: 's1', kind: 'tip', key: 'k', text_ru: 'x', yes_label: 'Да', no_label: 'Нет', do: {}, status: 'dismissed' }],
        habits: [{ id: 'h9', kind: 'placement_rule', status: 'active', text_ru: 'Чеки кладу в «Расходы»', page: null, evidence_count: 2, updated_at: iso(Date.now()), seq: 3 }],
        pending_actions: [],
        next_since: 3000,
        has_more: false,
      },
    }));
    await sync(outbox);
    expect(useToday.getState().answered).toContain('s1');
    s.offline = true;
    await renderRouter(APP_DIR, { initialUrl: '/habits' });
    await settle(() => screen.queryByTestId('habit-h9') !== null);
  });
});
