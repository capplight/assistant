import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { planCardOut } from '@/api/endpoints';
import { wordDiff } from '@/records/diff';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { usePages } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { happyServer, type FakeServer, type SseEvent } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testRecords } from '@/testing/helpers';
import { STICKER_PICKER_KEYS } from '@/theme';

/** docs/api/plans.md «Составь план»: the card, the plan screen, «Сделать делами», the inline edit, the 8th sticker. */

const iso = () => new Date().toISOString();
const NOTES_SRV = 'srv-notes';
const seqd = (events: Omit<SseEvent, 'id'>[]): SseEvent[] => events.map((e, i) => ({ ...e, id: i + 1 }));

let s: FakeServer;
beforeEach(() => {
  s = happyServer();
  resetApp({ fetch: s.fetch });
  finishOnboarding('full');
  usePages.setState({ pages: usePages.getState().pages.map((p) => (p.templateKey === 'notes' ? { ...p, serverId: NOTES_SRV } : p)) });
});

const tripCard = {
  item_id: 'plan-1',
  kind: 'trip',
  title: 'Стамбул',
  subtitle: '5 дней · 23 совета',
  lead: 'Собрал из 23 советов. 3 пункта — мои, не из ваших записей.',
  rows: [
    { n: 1, date: '2026-12-10', title: 'Султанахмет, Гранд-базар', points: 4, due_date: null, after_n: [], note: null },
    { n: 2, date: '2026-12-11', title: 'Балат и Фенер', points: 3, due_date: null, after_n: [], note: null },
    { n: 3, date: '2026-12-12', title: 'Кадыкёй, паром', points: 3, due_date: null, after_n: [], note: null },
    { n: 4, date: '2026-12-13', title: 'Принцевы острова', points: 3, due_date: null, after_n: [], note: null },
  ],
  start_date: '2026-12-10',
  end_date: '2026-12-14',
  page: { page_id: NOTES_SRV, title: 'Заметки' },
  check_note: 'составил по вашим записям — проверьте',
  can_make_tasks: false,
  action_id: 'a-plan',
  edited: false,
};

const tripPlan = {
  id: 'plan-1',
  kind: 'trip',
  title: 'Стамбул',
  start_date: '2026-12-10',
  end_date: '2026-12-14',
  days: [
    {
      n: 1,
      date: '2026-12-10',
      title: 'Султанахмет',
      points: [
        { id: 'd1p1', title: 'Голубая мечеть', note: 'до 10 утра', source_id: 'src-1', own: false, place: 'Голубая мечеть, Стамбул' },
        { id: 'd1p3', title: 'Обед у Сулеймание', note: null, source_id: null, own: true, place: null },
      ],
    },
  ],
  steps: [],
  sources: [{ item_id: 'src-1', title: 'Балат — цветные дома', kind: 'link', created_at: iso(), available: true, occurred_at: '2026-10-03T09:00:00Z' }],
  counts: { points: 2, from_records: 1, own: 1, sources: 1 },
  asked: 'составь план поездки в Стамбул',
  text: 'Стамбул',
  pages: [{ page_id: NOTES_SRV, title: 'Заметки' }],
  can_make_tasks: false,
  check_note: 'составил по вашим записям — проверьте',
};

const actionPlan = {
  ...tripPlan,
  id: 'plan-2',
  kind: 'actions',
  title: 'Ремонт кухни',
  start_date: null,
  end_date: null,
  days: [],
  steps: [
    { id: 'st1', n: 1, title: 'Вызвать замерщика', note: 'номер в заметках', due_date: '2026-11-20', after: [], remind_at: null, source_id: null, own: false, task_id: null, task: null },
    { id: 'st2', n: 2, title: 'Выбрать фасады', note: null, due_date: '2026-11-22', after: ['st1'], remind_at: null, source_id: null, own: false, task_id: null, task: null },
  ],
  can_make_tasks: true,
};

describe('the «План» card in the chat', () => {
  it('parses the card; the chat shows it (lead, 3 days, the check note, «Открыть»), no «Сохранить»', async () => {
    const card = planCardOut(tripCard)!;
    expect(card).toMatchObject({ item_id: 'plan-1', kind: 'trip', can_make_tasks: false });
    const q: ChatMessage = { id: 'q', role: 'user', text: 'составь план поездки в Стамбул', pageId: 'assistant', pageTitle: 'Помощник', at: iso() };
    const a: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      text: '',
      status: 'done',
      pageId: 'assistant',
      pageTitle: 'Помощник',
      at: iso(),
      replyTo: 'q',
      action: { id: 'a-plan', kind: 'save_item', text: 'Сохранил план', textKk: null, pageServerId: NOTES_SRV, pageTitle: 'Заметки', changedItemIds: ['plan-1'], changes: [], createdPageId: null, undoable: true, undone: false, plan: card },
    };
    useAssistant.setState({ messages: [q, a] });
    const r = await renderRouter(APP_DIR, { initialUrl: '/assistant' });
    const el = screen.getByTestId('plan-card-m1');
    expect(el).toHaveTextContent(/План · в «Заметки»/);
    expect(el).toHaveTextContent(/Стамбул · 5 дней · 23 совета/);
    expect(el).toHaveTextContent(/Кадыкёй, паром/);
    expect(el).not.toHaveTextContent(/Принцевы острова/);
    expect(el).toHaveTextContent(/составил по вашим записям — проверьте/);
    expect(screen.queryByText('Сохранить')).toBeNull();
    expect(screen.queryByTestId('plan-card-m1-tasks')).toBeNull();
    expect(screen.getByTestId('chat-undo-m1')).toBeTruthy();
    expect(screen.getByText('Собрал из 23 советов. 3 пункта — мои, не из ваших записей.')).toBeTruthy();
    s.on('GET /plans/plan-1', () => ({ status: 200, body: tripPlan }));
    await fireEvent.press(screen.getByTestId('plan-card-m1-open'));
    await settle(() => r.getPathname() === '/plan/plan-1');
  });

  it('the SSE `plan` event puts the card on the answer', async () => {
    const action = {
      id: 'a-plan', kind: 'save_item', scope: 'internal', initiated_by: 'agent', summary: { ru: 'Сохранил план «Стамбул»', kk: null },
      page: { id: NOTES_SRV, title: 'Заметки', icon: 'documents' }, changes: [], changed_item_ids: ['plan-1'], created_page_id: null,
      undoable: true, undoable_until: null, undone_at: null, undo_of: null, message_id: null, seq: 10, created_at: iso(),
    };
    s.on('POST /chat/messages', () => ({
      status: 200,
      sse: seqd([
        { event: 'accepted', data: { message_id: 'u-r1', reply_id: 'r1', created_at: iso() } },
        { event: 'action', data: { reply_id: 'r1', action, changed_item_ids: ['plan-1'], page_id: NOTES_SRV } },
        { event: 'plan', data: { reply_id: 'r1', action_id: 'a-plan', removed: 0, plan: tripCard } },
        { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'action', action_id: 'a-plan', delivery: 'streamed', limited: false } },
      ]),
    }));
    await renderRouter(APP_DIR, { initialUrl: '/assistant' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'составь план поездки в Стамбул');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => useAssistant.getState().messages.some((m) => m.action?.plan?.item_id === 'plan-1'));
  });
});

describe('the plan screen', () => {
  it('a trip: the day with its date, numbered points, the source «ссылка · 3 окт. ›», «на карте», the own tip in terracotta', async () => {
    s.on('GET /plans/plan-1', () => ({ status: 200, body: tripPlan }));
    await renderRouter(APP_DIR, { initialUrl: '/plan/plan-1' });
    await settle(() => screen.queryByTestId('plan-day-1') !== null);
    expect(screen.getByTestId('plan-top')).toHaveTextContent(/10–14 декабря · составил по вашим записям — проверьте/);
    expect(screen.getByTestId('plan-day-1')).toHaveTextContent(/10 декабря · Султанахмет/);
    expect(screen.getByTestId('plan-point-d1p1')).toHaveTextContent(/1Голубая мечеть — до 10 утра/);
    expect(screen.getByTestId('plan-src-d1p1')).toHaveTextContent(/ссылка · 3 окт\. ›/);
    expect(screen.getByTestId('plan-map-d1p1')).toHaveTextContent('на карте');
    expect(screen.getByTestId('plan-point-d1p3')).toHaveTextContent(/мой совет, не из ваших записей/);
    expect(screen.queryByTestId('plan-map-d1p3')).toBeNull();
  });

  it('an action plan: deadlines, «после шага 1»; «Сделать делами» → one notice, «Отменить» undoes the group', async () => {
    s.on('GET /plans/plan-2', () => ({ status: 200, body: actionPlan }));
    const done = {
      ...actionPlan,
      can_make_tasks: false,
      steps: actionPlan.steps.map((x, i) => ({ ...x, task_id: `t${i}`, task: { id: `t${i}`, done: false, due_date: x.due_date } })),
    };
    s.on('POST /plans/plan-2/tasks', () => ({
      status: 200,
      body: {
        plan: done,
        group: { id: 'g1', size: 2, index: 0, action_ids: ['x1', 'x2'], notice: { text_ru: 'Сделал 2 дела', text_kk: null, target: null, undo_label_ru: 'Отменить всё', undo_label_kk: null, ms: 3000 } },
        actions: [], tasks: [], reminders: [], page_patches: [], skipped: 0, repeated: false, message_ru: 'Сделал 2 дела.',
      },
    }));
    s.on('POST /actions/groups/g1/undo', () => ({ status: 200, body: { undone: [], failed: [], partial: false, message_ru: 'Вернул как было', page_patches: [] } }));
    await renderRouter(APP_DIR, { initialUrl: '/plan/plan-2' });
    await settle(() => screen.queryByTestId('plan-steps') !== null);
    expect(screen.getByTestId('plan-step-st2')).toHaveTextContent(/после шага 1/);
    expect(screen.getByTestId('plan-step-st1')).toHaveTextContent(/номер в заметках/);
    await fireEvent.press(screen.getByTestId('plan-make-tasks'));
    await settle(() => s.callsTo('POST /plans/plan-2/tasks').length === 1);
    expect(s.callsTo('POST /plans/plan-2/tasks')[0]!.body).toMatchObject({ client_id: expect.any(String) });
    await settle(() => screen.queryByTestId('plan-make-tasks') === null);
    expect(screen.getByTestId('plan-step-state-st1')).toHaveTextContent('в делах');
    const strip = useUndo.getState().strip as { kind: string; text: string; onUndo: () => void };
    expect(strip).toMatchObject({ kind: 'custom', text: 'Сделал 2 дела' });
    await act(async () => strip.onUndo());
    await settle(() => s.callsTo('POST /actions/groups/g1/undo').length === 1);
  });

  it('a plan record opens the plan screen, not the note', async () => {
    await testRecords.applyRemote({ id: 'plan-1', kind: 'plan', source: 'system', status: 'ready', title: 'Стамбул', text: 'Стамбул', seq: 5, created_at: iso(), updated_at: iso(), occurred_at: iso() } as never);
    const rec = (await testRecords.findByServerId('plan-1'))!;
    s.on('GET /plans/plan-1', () => ({ status: 200, body: tripPlan }));
    const r = await renderRouter(APP_DIR, { initialUrl: `/record/${rec.id}` });
    await settle(() => r.getPathname() === '/plan/plan-1');
  });
});

describe('the inline edit of the assistant (items.md «Inline edit»)', () => {
  it('a word diff: the old struck, the new marked, the rest kept', () => {
    expect(wordDiff('Паром в Кадыкёй идёт 40 минут', 'Паром в Кадыкёй идёт 20 минут\nБрать жетон')).toEqual([
      { kind: 'same', text: 'Паром в Кадыкёй идёт ' },
      { kind: 'del', text: '40 ' },
      { kind: 'ins', text: '20 ' },
      { kind: 'same', text: 'минут\n' },
      { kind: 'ins', text: 'Брать жетон' },
    ]);
  });

  it('the note shows «по просьбе», the plate with «Отменить», «40» struck and «20» marked', async () => {
    const after = 'Паром в Кадыкёй идёт 20 минут\nБрать жетон';
    await testRecords.applyRemote({
      id: 'n-1', kind: 'note', source: 'typed', status: 'ready', title: 'Паром', text: after, seq: 6, created_at: iso(), updated_at: iso(), occurred_at: iso(),
      assistant_changed_at: iso(), assistant_action_id: 'a-edit',
      assistant_edit: { action_id: 'a-edit', at: iso(), said: 'исправь в заметке: 20 минут', summary: 'Исправил «Паром».', changes: [{ field: 'text', before: 'Паром в Кадыкёй идёт 40 минут', after }] },
    } as never);
    const rec = (await testRecords.findByServerId('n-1'))!;
    await renderRouter(APP_DIR, { initialUrl: `/record/${rec.id}` });
    await settle(() => screen.queryByTestId('record-text') !== null);
    expect(screen.getByTestId('record-edit-said')).toHaveTextContent('по просьбе: «исправь в заметке: 20 минут»');
    expect(screen.getAllByTestId('record-text-del')[0]).toHaveTextContent('40');
    expect(screen.getAllByTestId('record-text-ins')[0]).toHaveTextContent('20');
    expect(screen.getByTestId('changed-plate')).toBeTruthy();
  });
});

describe('stickers: all 8 colours can be chosen', () => {
  it('aqua is a stored key now', () => {
    expect(STICKER_PICKER_KEYS).toEqual(['yellow', 'blue', 'pink', 'green', 'lilac', 'peach', 'aqua', 'white']);
  });
});
