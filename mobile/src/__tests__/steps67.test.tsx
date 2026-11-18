import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { router } from 'expo-router';

import type { InMemoryOutboxRepository } from '@/db';
import { setFilePickerForTests } from '@/dedup/pickFile';
import { AI_IMPORT_MAX_BYTES } from '@/dedup/service';
import { getSyncEngine } from '@/services';
import { useAssistant } from '@/store/assistant';
import { usePages } from '@/store/pages';
import { happyServer, itemOut, linkOut, type FakeServer, type SseEvent } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages, testRecords } from '@/testing/helpers';

/**
 * VISION-2026-11 steps 6–7 on the phone: one phrase → several actions with ONE notice and «Отменить всё» (actions.md
 * «Groups»), «Принести переписку» (import.md step 7), and «Чаты ИИ» apart from «Заметки» (Ф-77).
 */
const NOTES_SRV = 'srv-notes';
const seqd = (events: Omit<SseEvent, 'id'>[]): SseEvent[] => events.map((e, i) => ({ ...e, id: i + 1 }));
const iso = (ms = Date.now()) => new Date(ms).toISOString();

function action(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id, kind: 'create_expense', scope: 'internal', initiated_by: 'agent', summary: { ru: summary, kk: null }, page: null, changes: [],
    changed_item_ids: [], created_page_id: null, undoable: true, undoable_until: null, undone_at: null, undo_of: null, message_id: 'r1',
    seq: 10, created_at: iso(), ...extra,
  };
}
const groupNotice = (text: string, undo: string | null) => ({ text_ru: text, text_kk: null, target: null, undo_label_ru: undo, undo_label_kk: null, ms: 3000 });
const change = (id: string, title: string) => ({ item_id: id, key: null, kind: 'create', title, text: title, page_id: null, reverted: false });

let s: FakeServer;
let outbox: InMemoryOutboxRepository;
function setup() {
  s = happyServer();
  outbox = resetApp({ fetch: s.fetch });
  finishOnboarding('full');
  usePages.setState({ pages: usePages.getState().pages.map((p) => (p.templateKey === 'notes' ? { ...p, serverId: NOTES_SRV } : p)) });
}

describe('one phrase, several actions (step 6)', () => {
  beforeEach(setup);

  it('ONE notice «Сделал 3 дела · Отменить всё»; the chat card has a row each; «Отменить всё» is the group undo, honest about a part', async () => {
    const group = { id: 'r1', size: 3, index: 0, action_ids: ['a1', 'a2', 'a3'], notice: groupNotice('Сделал 3 дела', 'Отменить всё') };
    const a1 = action('a1', 'Записал трату: хлеб 400 ₸', { changes: [change('srv-1', 'Хлеб — 400 ₸')] });
    const a2 = action('a2', 'Записал трату: молоко 600 ₸', { changes: [change('srv-2', 'Молоко — 600 ₸')], group: { ...group, index: 1 } });
    const a3 = action('a3', 'Записал в «Дела»: оплатить свет', { kind: 'create_task', changes: [change('srv-3', 'Оплатить свет')], group: { ...group, index: 2 } });
    s.on('POST /chat/messages', () => ({
      status: 200,
      sse: seqd([
        { event: 'accepted', data: { message_id: 'u1', reply_id: 'r1', created_at: iso() } },
        { event: 'action', data: { reply_id: 'r1', action: a1, changed_item_ids: ['srv-1'] } },
        { event: 'action', data: { reply_id: 'r1', action: a2, changed_item_ids: ['srv-2'] } },
        { event: 'action', data: { reply_id: 'r1', action: a3, changed_item_ids: ['srv-3'] } },
        { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'action', action_ids: ['a1', 'a2', 'a3'], group, delivery: 'streamed', limited: false } },
      ]),
    }));
    s.on('POST /actions/groups/r1/undo', () => ({
      status: 200,
      body: {
        undone: [
          { action: { ...a3, undoable: false, undone_at: iso() }, undo: null, partial: false, repeated: false, message_ru: null, page_patches: [] },
          { action: { ...a2, undoable: false, undone_at: iso() }, undo: null, partial: false, repeated: false, message_ru: null, page_patches: [] },
        ],
        failed: [a1],
        partial: false,
        message_ru: 'Вернул 2 из 3: остальное уже нельзя отменить.',
        page_patches: [],
      },
    }));
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'купил хлеб за 400 и молоко за 600, и запиши оплатить свет');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    const answer = () => useAssistant.getState().messages.find((m) => m.role === 'assistant')!;
    await settle(() => answer()?.status === 'done' && (answer().action?.parts?.length ?? 0) === 3);
    expect(answer().action?.group?.id).toBe('r1');
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Сделал 3 дела');
    expect(screen.getByTestId('undo-strip-undo')).toHaveTextContent('Отменить всё');

    await fireEvent.press(screen.getByTestId('tab-assistant'));
    const card = within(screen.getByTestId(`chat-action-${answer().id}`));
    expect(card.getByText('Сделал 3 дела')).toBeTruthy();
    for (const i of [0, 1, 2]) expect(card.getByTestId(`chat-action-row-${i}`)).toBeTruthy();
    expect(card.getByText('Оплатить свет')).toBeTruthy();
    await fireEvent.press(card.getByTestId(`chat-undo-${answer().id}`));
    await settle(() => s.callsTo('POST /actions/groups/r1/undo').length === 1);
    await settle(() => screen.queryByText('Вернул 2 из 3: остальное уже нельзя отменить.') !== null);
    const parts = answer().action!.parts!;
    expect(parts.find((p) => p.id === 'a1')?.undone).toBe(false);
    expect(parts.find((p) => p.id === 'a2')?.undone).toBe(true);
    expect(s.callsTo('POST /actions/a1/undo')).toHaveLength(0);
  });
});

describe('«Принести переписку» (step 7)', () => {
  beforeEach(setup);

  it('ChatGPT how-to → file → upload → POST /imports/ai-chats/file → progress → the server’s summary → «Удалить импорт»', async () => {
    let polls = 0;
    const imp = (extra: Record<string, unknown>) => ({ id: 'imp9', client_id: null, source: 'ai_chat_export_file', status: 'running', provider: 'chatgpt', total: 312, processed: 0, created: 0, skipped_dups: 0, seen_before: 0, skipped_media: {}, failed: 0, action_id: null, seq: 1, ...extra });
    s.on('POST /imports/ai-chats/file', () => ({ status: 202, body: { import: imp({}), created: true } }))
      .on('GET /imports/*', () => {
        polls++;
        return {
          status: 200,
          body: { import: polls < 2 ? imp({ processed: 120, seq: 2 }) : imp({ status: 'done', processed: 312, conversations: 312, created: 330, action_id: 'aimp9', summary_ru: 'Принёс 312 разговоров из ChatGPT. Повторов не взял: 3.', seq: 3 }) },
        };
      })
      .on('POST /actions/*/undo', () => ({ status: 200, body: { action: null, undo: null, partial: false, repeated: false, message_ru: null, page_patches: [] } }));
    await (await getSyncEngine()).run();
    setFilePickerForTests(async () => ({ uri: 'file:///cache/chatgpt.zip', name: 'chatgpt-export.zip', mime: 'application/zip', size: 4_000_000 }));
    // QA B «Ещё» 1: «Принести переписку» lives in «Переписки с ChatGPT» now.
    const r = await renderRouter(APP_DIR, { initialUrl: '/ai-chats' });
    await settle(() => screen.queryByTestId('aichats-import') !== null);
    await fireEvent.press(screen.getByTestId('aichats-import'));
    await settle(() => r.getPathname() === '/ai-import');
    expect(screen.getByTestId('aiimp-how')).toHaveTextContent(/Как принести из ChatGPT/);
    await fireEvent.press(screen.getByTestId('aiimp-provider-gemini'));
    expect(screen.getByTestId('aiimp-how')).toHaveTextContent(/Google Takeout/);
    await fireEvent.press(screen.getByTestId('aiimp-pick'));
    await settle(() => outbox.all().some((e) => e.kind === 'import.ai_chats'));
    await act(async () => {
      const e = await getSyncEngine();
      await e.whenIdle();
      for (const row of outbox.all()) if (row.status === 'pending') await outbox.markRetry(row.id, 'test', 0);
      await e.run();
    });
    await settle(() => s.callsTo('POST /imports/ai-chats/file').length === 1);
    expect(s.callsTo('POST /imports/ai-chats/file')[0]!.body).toMatchObject({ upload_id: expect.stringMatching(/^up-/) });
    await settle(() => screen.queryByTestId('aiimp-progress') !== null || screen.queryByTestId('aiimp-done') !== null);
    await settle(() => screen.queryByTestId('aiimp-done') !== null);
    expect(screen.getByTestId('aiimp-summary')).toHaveTextContent('Принёс 312 разговоров из ChatGPT. Повторов не взял: 3.');
    await fireEvent.press(screen.getByTestId('aiimp-undo'));
    // v5: «Удалить импорт» asks once, compactly.
    await fireEvent.press(screen.getByTestId('compact-confirm-ok'));
    await settle(() => s.callsTo('POST /actions/aimp9/undo').length === 1);
  });

  it('a ChatGPT zip over 50 MB: send `conversations.json` from it; a refused file says why', async () => {
    s.on('POST /imports/ai-chats/file', () => ({ status: 422, body: { code: 'import_not_chats_file', message_ru: '', message_kk: '' } }));
    await (await getSyncEngine()).run();
    let file = { uri: 'file:///cache/big.zip', name: 'big.zip', mime: 'application/zip', size: AI_IMPORT_MAX_BYTES + 1 };
    setFilePickerForTests(async () => file);
    await renderRouter(APP_DIR, { initialUrl: '/ai-import' });
    await fireEvent.press(screen.getByTestId('aiimp-pick'));
    await settle(() => screen.queryByText(/пришлите только conversations\.json/) !== null);
    expect(outbox.all().some((e) => e.kind === 'import.ai_chats')).toBe(false);
    file = { uri: 'file:///cache/notes.json', name: 'notes.json', mime: 'application/json', size: 100 };
    await fireEvent.press(screen.getByTestId('aiimp-pick'));
    await settle(() => outbox.all().some((e) => e.kind === 'import.ai_chats'));
    await act(async () => {
      const e = await getSyncEngine();
      await e.whenIdle();
      for (const row of outbox.all()) if (row.status === 'pending') await outbox.markRetry(row.id, 'test', 0);
      await e.run();
    });
    await settle(() => screen.queryByTestId('aiimp-failed') !== null);
    expect(screen.getByTestId('aiimp-error')).toHaveTextContent(/^Это не файл переписки/);
  });
});

describe('«Чаты ИИ» apart from «Заметки» (Ф-77)', () => {
  beforeEach(setup);

  it('imported chats are not on «Заметки» even when linked there; «Ещё → Чаты ИИ» lists them with «из ChatGPT» and finds them', async () => {
    const chat = (id: string, title: string, text: string) =>
      itemOut(id, 3, { kind: 'ai_chat', source: 'import_ai_chat', title, text, status: 'ready', source_meta: { tag: 'из ChatGPT', title_source: 'import' } });
    await testRecords.applyRemote(chat('c1', 'Кафе в Стамбуле', 'Я: Посоветуй кафе в Стамбуле\n\nChatGPT: Попробуйте Mandabatmaz.'));
    await testRecords.applyRemote(chat('c2', 'Рецепт плова', 'Я: Как сварить плов?\n\nChatGPT: Возьмите рис девзира.'));
    await testRecords.applyRemote(itemOut('n1', 4, { text: 'Код домофона 4512', status: 'ready' }));
    await testPages.applyLink(linkOut(NOTES_SRV, 'srv-c1', 5));
    const notes = usePages.getState().pages.find((p) => p.templateKey === 'notes')!;
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByText(/Код домофона 4512/) !== null);
    expect(screen.queryByText(/Кафе в Стамбуле/)).toBeNull();
    expect(screen.queryByText(/Рецепт плова/)).toBeNull();

    await act(async () => router.navigate('/more'));
    await fireEvent.press(screen.getByTestId('more-ai-chats'));
    await settle(() => screen.queryByTestId('page-ai-chats') !== null);
    await settle(() => screen.queryByTestId('record-c1') !== null);
    expect(screen.getByTestId('record-tag-c1')).toHaveTextContent('из ChatGPT');
    expect(screen.getByTestId('record-c2')).toBeTruthy();
    expect(screen.queryByTestId('record-n1')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('aichats-find'), 'плов');
    await settle(() => screen.queryByTestId('record-c1') === null);
    expect(screen.getByTestId('record-c2')).toBeTruthy();
  });
});
