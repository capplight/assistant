import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';

import { markFresh } from '@/components/ChangedMark';
import { getSyncEngine } from '@/services';
import { useAssistant } from '@/store/assistant';
import { usePages } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { useTasks } from '@/tasks/store';
import { happyServer, itemOut, type FakeServer, type SseEvent } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testRecords } from '@/testing/helpers';

/**
 * VISION-2026-11 steps 3–4 on the phone: the 3-second top notice from `action.notice` (Ф-65, Ф-67, Ф-75), «Удалено ·
 * Восстановить» (Ф-66), «верни как было» in the chat (Ф-67), the «изменил помощник» mark (Ф-73), «разберу позже» (Ф-69).
 */
const NOTES_SRV = 'srv-notes';
const EXP_SRV = 'srv-exp';
const seqd = (events: Omit<SseEvent, 'id'>[]): SseEvent[] => events.map((e, i) => ({ ...e, id: i + 1 }));
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const page = (key: string) => usePages.getState().pages.find((p) => p.templateKey === key)!;

function action(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id, kind: 'save_item', scope: 'internal', initiated_by: 'agent', summary: { ru: summary, kk: null }, page: null, changes: [],
    changed_item_ids: [], created_page_id: null, undoable: true, undoable_until: null, undone_at: null, undo_of: null, message_id: null,
    seq: 10, created_at: iso(), ...extra,
  };
}
const notice = (text: string, undo: string | null, target: Record<string, unknown> | null = null) => ({
  text_ru: text, text_kk: null, target, undo_label_ru: undo, undo_label_kk: null, ms: 3000,
});

let s: FakeServer;
function setup() {
  s = happyServer();
  resetApp({ fetch: s.fetch });
  finishOnboarding('full');
  usePages.getState().addPage('expenses');
  usePages.setState({
    pages: usePages.getState().pages.map((p) =>
      p.templateKey === 'notes' ? { ...p, serverId: NOTES_SRV } : p.templateKey === 'expenses' ? { ...p, serverId: EXP_SRV } : p,
    ),
  });
}

function reply(events: Omit<SseEvent, 'id'>[]): SseEvent[] {
  return seqd([
    { event: 'accepted', data: { message_id: 'u-r1', reply_id: 'r1', created_at: iso() } },
    ...events,
    { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'action', delivery: 'streamed', limited: false } },
  ]);
}

async function say(text: string, url = '/') {
  const r = await renderRouter(APP_DIR, { initialUrl: url });
  await fireEvent.changeText(screen.getByTestId('assistant-input'), text);
  await fireEvent.press(screen.getByTestId('assistant-send'));
  return r;
}

describe('the top notice (Ф-65, Ф-67)', () => {
  beforeEach(setup);

  it('shows the server’s words and button at the top, goes after 3 s; a tap on the text opens the target page', async () => {
    const a = action('a1', 'Записал трату: кофе 1 200 ₸', { notice: notice('Кофе 1 200 ₸ → Расходы', 'Отменить', { kind: 'expense', id: 'e1', page_id: EXP_SRV }) });
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply([{ event: 'action', data: { reply_id: 'r1', action: a, changed_item_ids: [] } }]) }));
    const r = await say('кофе 1200');
    await settle(() => screen.queryByTestId('undo-strip') !== null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Кофе 1 200 ₸ → Расходы');
    expect(screen.getByTestId('undo-strip-undo')).toHaveTextContent('Отменить');
    // Not in the bottom column any more.
    expect(within(screen.getByTestId('main-footer')).queryByTestId('undo-strip')).toBeNull();
    await fireEvent.press(screen.getByTestId('undo-strip-open'));
    await settle(() => r.getPathname() === `/page/${page('expenses').id}`);
    await act(async () => useUndo.getState().showAction(useAssistant.getState().messages.find((m) => m.role === 'assistant')!.id));
    await settle(() => screen.queryByTestId('undo-strip') !== null);
    await settle(() => screen.queryByTestId('undo-strip') === null, 600);
  });

  it('the button is `notice.undo_label_ru` → POST /actions/{id}/undo; null shows no button', async () => {
    const a = action('a2', 'Записал в «Дела»', { notice: notice('Записал в «Дела»', 'Отменить') });
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply([{ event: 'action', data: { reply_id: 'r1', action: a, changed_item_ids: [] } }]) }));
    await say('позвонить в банк завтра');
    await settle(() => screen.queryByTestId('undo-strip-undo') !== null);
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/a2/undo').length === 1);

    const bNotice = { text_ru: 'Обновил трату', text_kk: null, target: null, undo_label_ru: null, undo_label_kk: null, ms: 3000 };
    const answer = useAssistant.getState().messages.find((m) => m.role === 'assistant')!;
    await act(async () => {
      useAssistant.getState().updateMessage(answer.id, { action: { id: 'a3', kind: 'edit', text: 'Обновил трату', textKk: null, pageServerId: null, pageTitle: null, changedItemIds: [], changes: [], createdPageId: null, undoable: false, notice: bNotice } });
      useUndo.getState().showAction(answer.id);
    });
    await settle(() => screen.queryByTestId('undo-strip') !== null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Обновил трату');
    expect(screen.queryByTestId('undo-strip-undo')).toBeNull();
  });

  it('a delete from the line is done at once: «Удалил «Шины»» · «Восстановить» (Ф-66, no «Да»)', async () => {
    const a = action('a4', 'Удалил «Шины»', { kind: 'delete_item', notice: notice('Удалил «Шины»', 'Восстановить', { kind: 'item', id: 'srv-shiny', page_id: null }) });
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply([{ event: 'action', data: { reply_id: 'r1', action: a, changed_item_ids: ['srv-shiny'] } }]) }));
    await say('удали шины');
    await settle(() => screen.queryByTestId('undo-strip') !== null);
    expect(screen.queryByTestId('answer-banner')).toBeNull();
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Удалил «Шины»');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/a4/undo').length === 1);
  });
});

describe('«верни как было» (Ф-67)', () => {
  beforeEach(setup);

  it('the chat shows «Вернул как было», the action it undid says «отменено»', async () => {
    const first = action('a5', 'Записал в «Дела»: купить хлеб', { changes: [{ item_id: 'srv-b', key: null, kind: 'create', title: 'Купить хлеб', text: 'Купить хлеб', page_id: null, reverted: false }] });
    let n = 0;
    s.on('POST /chat/messages', () => {
      n += 1;
      if (n === 1) return { status: 200, sse: reply([{ event: 'action', data: { reply_id: 'r1', action: first, changed_item_ids: ['srv-b'] } }]) };
      const undo = action('a6', '«Купить хлеб» снова в «Заметках», будильник убрал', { kind: 'undo', undo_of: 'a5', undoable: false, notice: notice('Вернул как было', 'Вернуть') });
      const undone = { ...first, undoable: false, undone_at: iso() };
      return {
        status: 200,
        sse: seqd([
          { event: 'accepted', data: { message_id: 'u-r2', reply_id: 'r2', created_at: iso() } },
          { event: 'action', data: { reply_id: 'r2', action: undo, undone, changed_item_ids: ['srv-b'] } },
          { event: 'token', data: { text: 'Готово. Если что — «История» в шапке хранит всё, что я менял.' } },
          { event: 'done', data: { reply_id: 'r2', state: 'done', answer_kind: 'action', delivery: 'streamed', limited: false } },
        ]),
      };
    });
    await say('купить хлеб завтра и напомни в 10', '/assistant');
    const answers = () => useAssistant.getState().messages.filter((m) => m.role === 'assistant');
    await settle(() => !!answers()[0]?.action);
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'нет, верни как было');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => answers().length === 2 && !!answers()[1]?.action);
    const [a1, a2] = answers();
    await settle(() => screen.queryByTestId(`chat-undo-result-${a2!.id}`) !== null);
    expect(within(screen.getByTestId(`chat-undo-result-${a2!.id}`)).getByText('Вернул как было')).toBeTruthy();
    expect(screen.getByText('«Купить хлеб» снова в «Заметках», будильник убрал')).toBeTruthy();
    expect(a1!.action?.undone).toBe(true);
    expect(screen.getByTestId(`chat-undone-${a1!.id}`)).toHaveTextContent('отменено');
    expect(screen.getByTestId(`chat-open-history-${a2!.id}`)).toBeTruthy();
  });
});

describe('«изменил помощник» (Ф-73)', () => {
  beforeEach(setup);

  it('a record changed by the assistant within 24 h has the mark; a tap shows what changed and «Отменить»', async () => {
    expect(markFresh(iso(Date.now() - 60_000))).toBe(true);
    expect(markFresh(iso(Date.now() - 25 * 3_600_000))).toBe(false);
    expect(markFresh(null)).toBe(false);
    await testRecords.applyRemote(itemOut('m1', 2, { text: 'Код домофона 4512, подъезд 3', status: 'ready', assistant_changed_at: iso(Date.now() - 60_000), assistant_action_id: 'a7' }));
    await testRecords.applyRemote(itemOut('m2', 3, { text: 'Плов у мамы', status: 'ready', assistant_changed_at: iso(Date.now() - 25 * 3_600_000), assistant_action_id: 'a8' }));
    s.on('GET /actions/a7', () => ({
      status: 200,
      body: action('a7', 'Дописал «подъезд 3»', { changes: [{ item_id: 'srv-m1', key: null, kind: 'edit', title: 'Код домофона', text: 'Текст: + «подъезд 3»', page_id: NOTES_SRV, reverted: false }] }),
    }));
    await renderRouter(APP_DIR, { initialUrl: '/records' });
    await settle(() => screen.queryByTestId('changed-m1') !== null);
    expect(screen.getByTestId('changed-m1')).toHaveTextContent('изменил помощник');
    expect(screen.queryByTestId('changed-m2')).toBeNull();
    await fireEvent.press(screen.getByTestId('changed-m1'));
    await settle(() => screen.queryByText('Дописал «подъезд 3»') !== null);
    expect(screen.getByText('Текст: + «подъезд 3»')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('changed-undo'));
    await settle(() => s.callsTo('POST /actions/a7/undo').length === 1);
  });

  it('a task the assistant made shows the mark on its row', async () => {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const t = { id: 't1', client_id: 't1', item_id: 'i1', list_key: 'todo', title: 'Позвонить в банк', qty: null, where: null, due_date: day, done: false, done_at: null, version: 1, seq: 1, created_at: iso(), updated_at: iso(), deleted_at: null, assistant_changed_at: iso(), assistant_action_id: 'a9' };
    useTasks.setState({ tasks: { t1: t } as never });
    await renderRouter(APP_DIR, { initialUrl: `/page/${page('tasks').id}` });
    await settle(() => screen.queryByTestId('changed-task-t1') !== null);
  });
});

describe('«разберу позже» (Ф-69)', () => {
  beforeEach(setup);

  it('a note waiting to be read says so; the background result comes by /sync as a notice', async () => {
    await testRecords.applyRemote(itemOut('w1', 2, {
      text: 'такси до аэропорта 4 500', status: 'ready',
      parse_later: { state: 'waiting', text_ru: 'Сохранил как заметку, разберу позже', text_kk: null, to: null, action_id: null },
    }));
    await renderRouter(APP_DIR, { initialUrl: '/records' });
    await settle(() => screen.queryByText('сохранил как заметку · разберу позже') !== null);
    const parsed = action('a10', 'Разобрал: перенёс в «Расходы»', { parsed_later: true, notice: notice('Разобрал: перенёс в «Расходы»', 'Отменить', { kind: 'expense', id: 'e2', page_id: EXP_SRV }) });
    s.on('GET /sync', () => ({ status: 200, body: { items: [], screens: [], screen_items: [], tombstones: [], actions: [parsed], next_since: 9, has_more: false } }));
    await act(async () => (await getSyncEngine()).pull());
    await settle(() => screen.queryByTestId('undo-strip') !== null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Разобрал: перенёс в «Расходы»');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/a10/undo').length === 1);
  });
});
