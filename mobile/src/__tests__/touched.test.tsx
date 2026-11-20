import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { proposalOut, actionOut } from '@/api/endpoints';
import type { CalendarEntryOut, TaskOut } from '@/api/types';
import { refreshRange } from '@/calendar/service';
import { calState } from '@/calendar/store';
import { isoDate } from '@/calendar/time';
import { undoAction } from '@/chat/service';
import { getSyncEngine } from '@/services';
import { useAssistant } from '@/store/assistant';
import { usePages } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { flushTouched, touchedOf, touchedTiming } from '@/sync/touched';
import { useTasks } from '@/tasks/store';
import { happyServer, itemOut, type FakeServer, type SseEvent } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';
import { useToday } from '@/today/service';

/**
 * Ф-95 (actions.md «touched»): after a change from the line, an undo or /sync, the phone asks again exactly what the
 * action touched and /sync does not bring — GET /calendar (the cached range), GET /expenses/budget, GET /today — and
 * the notice opens the calendar day / «Расходы» by `notice.target`.
 */
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const seqd = (events: Omit<SseEvent, 'id'>[]): SseEvent[] => events.map((e, i) => ({ ...e, id: i + 1 }));
const TODAY_BODY = { sections: [], today: { reminders: [], tasks: [], shopping: null }, missed: [], done_for_you: { actions: [], count_today: 0 }, proposals: [], tip: null, empty: false };

function action(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, kind: 'patch_task', scope: 'internal', initiated_by: 'agent', summary: { ru: 'Перенёс встречу', kk: null }, page: null, changes: [],
    changed_item_ids: [], created_page_id: null, undoable: true, undoable_until: null, undone_at: null, undo_of: null, message_id: null,
    seq: 10, created_at: iso(), ...extra,
  };
}
const notice = (target: Record<string, unknown> | null) => ({ text_ru: 'Перенёс «Встреча» на 16:00', text_kk: null, target, undo_label_ru: 'Отменить', undo_label_kk: null, ms: 3000 });
const task = (o: Partial<TaskOut> & { id: string }): TaskOut => ({
  client_id: null, item_id: null, list_key: 'todo', title: o.id, qty: null, where: null, due_date: null, done: false, done_at: null,
  version: 1, seq: 1, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', deleted_at: null, ...o,
});

function reply(events: Omit<SseEvent, 'id'>[]): SseEvent[] {
  return seqd([
    { event: 'accepted', data: { message_id: 'u-r1', reply_id: 'r1', created_at: iso() } },
    ...events,
    { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'action', delivery: 'streamed', limited: false } },
  ]);
}

let s: FakeServer;
let calendarSeen: number[] = [];
function setup() {
  s = happyServer();
  calendarSeen = [];
  s.on('GET /today', () => ({ status: 200, body: TODAY_BODY })).on('GET /calendar', (c) => {
    // What the calendar holds while it is asked again: never emptied first (QA-3, no flash).
    calendarSeen.push(Object.keys(calState().server).length);
    return { status: 200, body: { tz: 'Asia/Almaty', from: c.query.from, to: c.query.to, now: iso(), entries: [] } };
  });
  resetApp({ fetch: s.fetch });
  finishOnboarding('full');
  usePages.getState().addPage('expenses');
  // Only `flushTouched()` runs the refetch here: the counts are read around it.
  touchedTiming.debounceMs = 1e9;
}
afterAll(() => {
  touchedTiming.debounceMs = 150;
});

async function say(text: string, url = '/') {
  const r = await renderRouter(APP_DIR, { initialUrl: url });
  await fireEvent.changeText(screen.getByTestId('assistant-input'), text);
  await fireEvent.press(screen.getByTestId('assistant-send'));
  return r;
}

const answer = () => useAssistant.getState().messages.find((m) => m.role === 'assistant');
const count = (r: string) => s.callsTo(r).length;

describe('touched → refetch (Ф-95)', () => {
  beforeEach(setup);

  it('decodes `touched`; absent stays absent (an older server)', () => {
    expect(actionOut(action('a', { touched: ['tasks', 'calendar', 'weird', 'today'] }))?.touched).toEqual(['tasks', 'calendar', 'today']);
    expect(actionOut(action('a'))?.touched).toBeUndefined();
    expect(touchedOf([actionOut(action('a'))])).toBeNull();
    expect([...touchedOf([actionOut(action('a', { touched: ['budget'] })), null])!]).toEqual(['budget']);
  });

  it('a chat action touching the calendar and «Сегодня» asks again for the cached range and /today, not the budget', async () => {
    await refreshRange('2026-11-16', '2026-11-22');
    calState().set({ server: { k1: { key: 'k1', date: '2026-11-17' } as unknown as CalendarEntryOut } });
    const a = action('a1', { touched: ['tasks', 'calendar', 'today'], notice: notice(null) });
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply([{ event: 'action', data: { reply_id: 'r1', action: a, changed_item_ids: [] } }]) }));
    await say('перенеси встречу на 16');
    await settle(() => !!answer()?.action);
    await settle(() => useToday.getState().last !== null);
    const [cal, today, budget] = [count('GET /calendar'), count('GET /today'), count('GET /expenses/budget')];
    await act(async () => void (await flushTouched()));
    expect(count('GET /calendar')).toBe(cal + 1);
    expect(s.callsTo('GET /calendar').at(-1)!.query).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(calendarSeen.at(-1)).toBe(1);
    expect(count('GET /today')).toBe(today + 1);
    expect(count('GET /expenses/budget')).toBe(budget);
  });

  it('an expense touches the budget: GET /expenses/budget; no `touched` → nothing more than before', async () => {
    let n = 0;
    s.on('POST /chat/messages', () => {
      n += 1;
      const a = n === 1 ? action('e1', { kind: 'create_expense', touched: ['records', 'expenses', 'budget', 'today'] }) : action('e2', { kind: 'create_expense' });
      return { status: 200, sse: reply([{ event: 'action', data: { reply_id: 'r1', action: a, changed_item_ids: [] } }]) };
    });
    await say('кофе 1200');
    await settle(() => !!answer()?.action);
    const budget = count('GET /expenses/budget');
    await act(async () => void (await flushTouched()));
    expect(count('GET /expenses/budget')).toBe(budget + 1);
    expect(count('GET /calendar')).toBe(0); // nothing cached: the calendar asks by itself when opened

    useAssistant.getState().reset();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'чай 500');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => n === 2 && !!answer()?.action);
    await act(async () => void (await flushTouched()));
    expect(count('GET /expenses/budget')).toBe(budget + 1);
  });

  it('«Отменить» from the chat refreshes the same screens (the undo’s `touched`)', async () => {
    await refreshRange('2026-11-16', '2026-11-22');
    const a = action('a7', { touched: ['tasks', 'calendar', 'today'] });
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply([{ event: 'action', data: { reply_id: 'r1', action: a, changed_item_ids: [] } }]) }));
    s.on('POST /actions/a7/undo', () => ({
      status: 200,
      body: {
        action: { ...a, undoable: false, undone_at: iso() },
        undo: action('u7', { kind: 'undo', undo_of: 'a7', undoable: false, touched: ['tasks', 'calendar', 'budget', 'today'] }),
        partial: false, repeated: false, message_ru: null, page_patches: [],
      },
    }));
    await say('перенеси встречу на 16', '/assistant');
    await settle(() => !!answer()?.action);
    await act(async () => void (await flushTouched()));
    const [cal, budget] = [count('GET /calendar'), count('GET /expenses/budget')];
    await act(async () => undoAction(answer()!.id));
    await act(async () => void (await flushTouched()));
    expect(count('POST /actions/a7/undo')).toBe(1);
    expect(count('GET /calendar')).toBe(cal + 1);
    expect(count('GET /expenses/budget')).toBe(budget + 1);
    expect(answer()!.action!.undone).toBe(true);
  });

  it('/sync: a new action refetches what it touched; the same one again does not', async () => {
    await refreshRange('2026-11-16', '2026-11-22');
    const a = action('s1', { initiated_by: 'agent', touched: ['tasks', 'calendar'] });
    s.on('GET /sync', (c) => ({
      status: 200,
      body: { items: [itemOut('x', 1)], tombstones: [], actions: [a], next_since: Number(c.query.since ?? 0) + 1, has_more: false },
    }));
    const cal = count('GET /calendar');
    await act(async () => void (await (await getSyncEngine()).run()));
    await act(async () => void (await flushTouched()));
    expect(count('GET /calendar')).toBe(cal + 1);
    expect(useTasks.getState().actions.s1).toBeTruthy();
    await act(async () => void (await (await getSyncEngine()).run()));
    await act(async () => void (await flushTouched()));
    expect(count('GET /calendar')).toBe(cal + 1);
  });
});

describe('notice.target: the calendar day and «Расходы»', () => {
  beforeEach(setup);

  async function noticeTap(target: Record<string, unknown>) {
    const a = action('n1', { notice: notice(target) });
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply([{ event: 'action', data: { reply_id: 'r1', action: a, changed_item_ids: [] } }]) }));
    const r = await say('перенеси встречу на 16');
    await settle(() => screen.queryByTestId('undo-strip') !== null);
    await fireEvent.press(screen.getByTestId('undo-strip-open'));
    return r;
  }
  const tasksPage = () => usePages.getState().pages.find((p) => p.templateKey === 'tasks')!;

  it('`calendar` with a day opens «Дела» as the calendar «День» on it', async () => {
    const day = isoDate(Date.now() + 3 * 86_400_000);
    const r = await noticeTap({ kind: 'calendar', id: day, page_id: null });
    await settle(() => r.getPathname() === `/page/${tasksPage().id}`);
    expect(calState().view).toBe('day');
    expect(calState().date).toBe(day);
    expect(useUndo.getState().strip).toBeNull();
  });

  it('`task` with a time → its day in the calendar, the block rung', async () => {
    const start = new Date(Date.now() + 2 * 86_400_000);
    start.setHours(16, 0, 0, 0);
    useTasks.setState({ tasks: { t1: task({ id: 't1', title: 'Встреча', start_at: start.toISOString(), duration_min: 60 }) } });
    const r = await noticeTap({ kind: 'task', id: 't1', page_id: null });
    await settle(() => r.getPathname() === `/page/${tasksPage().id}`);
    expect(calState().date).toBe(isoDate(start.getTime()));
    expect(calState().focus?.taskId).toBe('t1');
  });

  it('`budget` opens «Расходы»', async () => {
    const r = await noticeTap({ kind: 'budget', id: null, page_id: null });
    const exp = usePages.getState().pages.find((p) => p.templateKey === 'expenses')!;
    await settle(() => r.getPathname() === `/page/${exp.id}`);
  });

  it('an unknown kind stays where it is', async () => {
    const r = await noticeTap({ kind: 'galaxy', id: 'x', page_id: null });
    await act(async () => undefined);
    expect(r.getPathname()).toBe('/');
  });
});

describe('chat options `date`, `mode`, `time` are buttons', () => {
  beforeEach(setup);

  it('keeps their kinds (not «Отмена») and shows each as a button in the chat', async () => {
    const p = proposalOut({
      reply_id: 'r1', kind: 'choice', question: 'Как добавить?',
      options: [
        { id: 'm1', label: 'По дню одним делом', kind: 'mode' },
        { id: 'd1', label: 'С завтра, 21 ноября', kind: 'date' },
        { id: 't1', label: 'Сегодня в 19:00', kind: 'time' },
        { id: 'cancel', label: 'Отмена', kind: 'cancel' },
      ],
    })!;
    expect(p.options.map((o) => o.kind)).toEqual(['mode', 'date', 'time', 'cancel']);
    s.on('POST /chat/messages', () => ({
      status: 200,
      sse: reply([{ event: 'needs_choice', data: { reply_id: 'r1', proposal: { reply_id: 'r1', kind: 'choice', question: 'Как добавить?', options: [
        { id: 'm1', label: 'По дню одним делом', kind: 'mode' },
        { id: 'd1', label: 'С завтра, 21 ноября', kind: 'date' },
        { id: 't1', label: 'Сегодня в 19:00', kind: 'time' },
      ] } } }]),
    }));
    await say('добавь план в календарь', '/assistant');
    await settle(() => screen.queryByTestId('chat-option-d1') !== null);
    for (const id of ['m1', 'd1', 't1']) expect(screen.getByTestId(`chat-option-${id}`)).toBeTruthy();
    expect(answer()!.proposal!.options.map((o) => o.kind)).toEqual(['mode', 'date', 'time']);
  });
});
