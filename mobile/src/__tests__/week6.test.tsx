import { router } from 'expo-router';
import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import { decodeChatEvent } from '@/api/endpoints';
import { chatTiming, lineRouting, patchesApplied } from '@/chat/service';
import { guessLine } from '@/records/search';
import { getSyncEngine } from '@/services';
import { useAssistant } from '@/store/assistant';
import { usePages } from '@/store/pages';
import { useView } from '@/store/view';
import type { FakeServer, SseEvent } from '@/testing/fakeServer';
import { happyServer, itemOut, linkOut } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages, testPush, testRecords } from '@/testing/helpers';

/**
 * Week 6 (US-24, US-28, US-30, 6.11): changes on the page from the line, «Что изменилось» /
 * «Отменить», questions back, the page context of a request, «Ответ готов» on «Сегодня», push.
 * Shapes: docs/api/chat.md + docs/api/actions.md (2026-11-07). Fake server only — not the real
 * backend, not a device.
 */

const NOTES_SRV = 'srv-notes';
const notesRef = { id: NOTES_SRV, title: 'Заметки', icon: 'documents' };
const N = 12;
const ids = Array.from({ length: N }, (_, i) => `n${i + 1}`);
const pos = (i: number) => String.fromCharCode(66 + i); // B, C, D… (bytes order)

const notes = () => usePages.getState().pages.find((p) => p.templateKey === 'notes')!;
const lastAnswer = () => useAssistant.getState().messages.filter((m) => m.role === 'assistant').at(-1);
const bg = (testId: string) => StyleSheet.flatten(screen.getByTestId(testId).props.style)?.backgroundColor;

let s: FakeServer;

/** «Заметки» on the server (view_version 3) with 12 records in page order. */
async function setup(o: { mode?: 'full' | 'no_ai' } = {}) {
  s = happyServer();
  const outbox = resetApp({ fetch: s.fetch });
  finishOnboarding(o.mode ?? 'full');
  usePages.setState({
    pages: usePages
      .getState()
      .pages.map((p) => (p.templateKey === 'notes' ? { ...p, serverId: NOTES_SRV, viewVersion: 3, createdBy: 'user' as const } : p)),
  });
  for (const [i, id] of ids.entries()) {
    await testRecords.applyRemote(itemOut(id, i + 1, { text: `Заметка ${i + 1}`, status: 'ready' }));
    await testPages.applyLink(linkOut(NOTES_SRV, `srv-${id}`, i + 1, { position: pos(i) }));
  }
  return outbox;
}

async function say(text: string, url = `/page/${notes().id}`) {
  const r = await renderRouter(APP_DIR, { initialUrl: url });
  await settle(() => screen.queryByTestId(`record-${ids[0]}`) !== null || !url.startsWith('/page'));
  await fireEvent.changeText(screen.getByTestId('assistant-input'), text);
  await fireEvent.press(screen.getByTestId('assistant-send'));
  return r;
}

const seqd = (events: Omit<SseEvent, 'id'>[]): SseEvent[] => events.map((e, i) => ({ ...e, id: i + 1 }));

const ACTION = {
  id: 'a1',
  kind: 'screen_reorder_items',
  scope: 'internal',
  initiated_by: 'agent',
  summary: { ru: 'Разложил 12 заметок в 2 группы', kk: null },
  page: notesRef,
  changes: [
    { item_id: 'srv-n1', title: 'Заметка 1', kind: 'group', text: '«Заметка 1» → Ремонт', page_id: NOTES_SRV, reverted: false },
    { item_id: 'srv-n2', title: 'Заметка 2', kind: 'group', text: '«Заметка 2» → Здоровье', page_id: NOTES_SRV, reverted: false },
  ],
  changed_item_ids: ['srv-n1', 'srv-n2'],
  created_page_id: null,
  undoable: true,
  undoable_until: '2026-12-07T10:00:00+00:00',
  undone_at: null,
  undo_of: null,
  message_id: 'r1',
  seq: 100,
  created_at: '2026-11-07T10:00:00+00:00',
};

/** «Ремонт» = odd records, «Здоровье» = even ones; positions in that order. */
const GROUPED = {
  page_id: NOTES_SRV,
  view_version: 4,
  view_state: { sort: 'position', groups: ['Ремонт', 'Здоровье'] },
  rows: ids.map((id, i) => {
    const g = i % 2 === 0 ? 0 : 1;
    return linkOut(NOTES_SRV, `srv-${id}`, 50 + i, { group_key: g === 0 ? 'Ремонт' : 'Здоровье', position: pos(g * N + i) });
  }),
  removed_item_ids: [],
};

function actionReply(): SseEvent[] {
  return seqd([
    { event: 'accepted', data: { message_id: 'u1', reply_id: 'r1', created_at: '2026-11-07T10:00:00Z' } },
    { event: 'tool_activity', data: { tool: 'reorder', text: 'Раскладываю…', page_id: NOTES_SRV } },
    { event: 'action', data: { reply_id: 'r1', action: ACTION, changed_item_ids: ACTION.changed_item_ids, page_id: NOTES_SRV } },
    { event: 'page_patch', data: GROUPED },
    { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'action', action_id: 'a1', delivery: 'streamed', limited: false } },
  ]);
}

function undoOut(itemIds?: string[]) {
  const back = (itemIds ?? ids.map((i) => `srv-${i}`)).map((itemId) => {
    const i = ids.indexOf(itemId.replace('srv-', ''));
    return linkOut(NOTES_SRV, itemId, 200 + i, { position: pos(i), group_key: null });
  });
  return {
    action: {
      ...ACTION,
      changes: ACTION.changes.map((c) => ({ ...c, reverted: !itemIds || itemIds.includes(c.item_id) })),
      undoable: !!itemIds,
      undone_at: itemIds ? null : '2026-11-07T10:01:00+00:00',
    },
    undo: { ...ACTION, id: 'a2', undo_of: 'a1', summary: { ru: 'Отменил: разложил 12 заметок', kk: null } },
    partial: false,
    repeated: false,
    message_ru: null,
    page_patches: [
      { page_id: NOTES_SRV, view_version: 5, view_state: itemIds ? GROUPED.view_state : { sort: 'position' }, rows: back, removed_item_ids: [] },
    ],
  };
}

function proposalReply(proposal: Record<string, unknown>, event: string): SseEvent[] {
  return seqd([
    { event: 'accepted', data: { message_id: 'u1', reply_id: 'r1', created_at: '2026-11-07T10:00:00Z' } },
    { event, data: { reply_id: 'r1', ...proposal } },
    { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'choice', action_id: null, delivery: 'streamed', limited: false } },
  ]);
}

const savedBackoff = chatTiming.resumeBackoffMs;
beforeEach(() => {
  chatTiming.resumeBackoffMs = [20, 20];
  lineRouting.serverDecides = true;
});
afterAll(() => {
  chatTiming.resumeBackoffMs = savedBackoff;
});

describe('decoding (docs/api/chat.md, actions.md)', () => {
  it('action, page_patch, the three Proposal events, done with action_id', () => {
    const action = decodeChatEvent({ event: 'action', data: JSON.stringify({ reply_id: 'r1', action: ACTION, changed_item_ids: ['srv-n1'], page_id: NOTES_SRV }), id: '3' });
    expect(action).toMatchObject({ type: 'action', action: { id: 'a1', summary: { ru: 'Разложил 12 заметок в 2 группы' }, undoable: true }, changedItemIds: ['srv-n1'] });
    expect(decodeChatEvent({ event: 'page_patch', data: JSON.stringify(GROUPED), id: '4' })).toMatchObject({
      type: 'page_patch',
      patch: { page_id: NOTES_SRV, view_version: 4, view_state: { groups: ['Ремонт', 'Здоровье'] }, removed_item_ids: [] },
    });
    for (const event of ['needs_choice', 'confirm', 'confirm_manual']) {
      expect(
        decodeChatEvent({ event, data: JSON.stringify({ kind: 'manual', question: 'Q?', options: [{ id: 'yes', label: 'Да', kind: 'yes' }], default: 'yes' }), id: null }),
      ).toMatchObject({ type: 'proposal', proposal: { kind: 'manual', question: 'Q?', default: 'yes', state: 'open' } });
    }
    expect(decodeChatEvent({ event: 'done', data: '{"answer_kind":"action","action_id":"a1"}', id: null })).toMatchObject({ answerKind: 'action', actionId: 'a1' });
    expect(decodeChatEvent({ event: 'general_answer_offer', data: '{}', id: null })).toBeNull();
  });

  it('the phone\'s own guess, for when the server can\'t be asked', () => {
    expect(guessLine('сколько стоила плитка?')).toBe('question');
    expect(guessLine('Разложи по темам')).toBe('action');
    expect(guessLine('удали это')).toBe('action');
    expect(guessLine('хлеб и молоко')).toBe('note');
  });
});

describe('the page context of a request', () => {
  it('visible_item_ids (top first, ≤40), view_version; on a record card «это» = that record', async () => {
    await setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: actionReply() }));
    await say('разложи по темам');
    await settle(() => s.callsTo('POST /chat/messages').length === 1);
    const body = s.callsTo('POST /chat/messages')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ text: 'разложи по темам', page_id: NOTES_SRV, view_version: 3, selected_item_id: null });
    expect(body.visible_item_ids).toEqual(ids.map((i) => `srv-${i}`));
    expect(body).not.toHaveProperty('choice');
  });

  it('on the record card', async () => {
    await setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: actionReply() }));
    await say('удали это', `/record/n5?from=${notes().id}`);
    await settle(() => s.callsTo('POST /chat/messages').length === 1);
    expect(s.callsTo('POST /chat/messages')[0]?.body).toMatchObject({ selected_item_id: 'srv-n5', page_id: NOTES_SRV });
  });
});

describe('US-24: «Разложи» → the result on the page, highlight 600 ms, «Что изменилось» / «Отменить»', () => {
  it('groups on the page, no banner, Переписка stays closed; highlight goes after 600 ms', async () => {
    await setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: actionReply() }));
    const r = await say('разложи по темам');
    await settle(() => screen.queryByTestId('group-Ремонт') !== null);
    expect(screen.getByTestId('group-Здоровье')).toBeTruthy();
    expect(within(screen.getByTestId('undo-strip')).getByText('Разложил 12 заметок в 2 группы')).toBeTruthy();
    expect(screen.getByTestId('undo-strip-changes')).toBeTruthy();
    expect(screen.queryByTestId('answer-banner')).toBeNull();
    expect(r.getPathname()).toBe(`/page/${notes().id}`);
    expect(notes().viewVersion).toBe(4);
    expect(bg('record-n1')).not.toBe(bg('record-n3'));
    await settle(() => bg('record-n1') === bg('record-n3'));
    // Then the records themselves come by /v1/sync (docs/api/chat.md «Notes for the phone»).
    await settle(() => s.callsTo('GET /sync').length > 0);
  });

  it('«Отменить»: POST /actions/a1/undo with a client_id; the old order and no groups', async () => {
    await setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: actionReply() }));
    s.on('POST /actions/*/undo', () => ({ status: 200, body: undoOut() }));
    await say('разложи по темам');
    await settle(() => screen.queryByTestId('group-Ремонт') !== null);
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => screen.queryByTestId('group-Ремонт') === null);
    const call = s.callsTo('POST /actions/a1/undo')[0];
    expect(call?.body).toMatchObject({ client_id: expect.any(String) });
    expect(call?.body).not.toHaveProperty('item_ids');
    expect(lastAnswer()?.action?.undone).toBe(true);
    expect(screen.getByText('Отменено')).toBeTruthy();
  });

  it('«Что изменилось» → «Вернуть» one row: item_ids of that record only', async () => {
    await setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: actionReply() }));
    s.on('POST /actions/*/undo', () => ({ status: 200, body: undoOut(['srv-n1']) }));
    await say('разложи по темам');
    await settle(() => screen.queryByTestId('undo-strip-changes') !== null);
    await fireEvent.press(screen.getByTestId('undo-strip-changes'));
    expect(within(screen.getByTestId('changes-sheet')).getByText('«Заметка 2» → Здоровье')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('change-revert-srv-n1'));
    await settle(() => s.callsTo('POST /actions/a1/undo').length === 1);
    expect(s.callsTo('POST /actions/a1/undo')[0]?.body).toMatchObject({ item_ids: ['srv-n1'] });
    await settle(() => screen.queryByText('Вернул') !== null);
    expect(lastAnswer()?.action?.undone).toBe(false);
  });

  it('offline «Отменить»: the page goes back at once, the undo waits in the outbox', async () => {
    const outbox = await setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: actionReply() }));
    s.on('POST /actions/*/undo', () => ({ status: 200, body: undoOut() }));
    await say('разложи по темам');
    await settle(() => screen.queryByTestId('group-Ремонт') !== null);
    await patchesApplied();
    s.offline = true;
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => outbox.all().some((e) => e.kind === 'action.undo'));
    await settle(() => screen.queryByTestId('group-Ремонт') === null);
    s.offline = false;
    await (await getSyncEngine()).push();
    // The same client_id as the attempt that did not get through: a repeat returns the first result.
    const queued = outbox.all().find((e) => e.kind === 'action.undo')?.payload as { clientId: string; actionId: string };
    expect(queued.actionId).toBe('a1');
    expect(s.callsTo('POST /actions/a1/undo').at(-1)?.body).toMatchObject({ client_id: queued.clientId });
  });

  it('nothing moves under a finger: the patch waits until the list is let go', async () => {
    await setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: actionReply() }));
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await settle(() => screen.queryByTestId('record-n1') !== null);
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'разложи по темам');
    useView.getState().setTouching(true);
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => lastAnswer()?.status === 'done');
    await settle(() => false, 10).catch(() => undefined);
    expect(screen.queryByTestId('group-Ремонт')).toBeNull();
    useView.getState().setTouching(false);
    await settle(() => screen.queryByTestId('group-Ремонт') !== null);
  });
});

describe('US-28: records placed by hand move only after «Да»', () => {
  const manual = {
    kind: 'manual',
    question: 'Вы сами расставили 4 записи. Переставить и их?',
    count: 4,
    item_ids: ['srv-n1', 'srv-n2', 'srv-n3', 'srv-n4'],
    options: [
      { id: 'yes', label: 'Да', kind: 'yes', item_id: null },
      { id: 'keep', label: 'Оставить мои', kind: 'keep_mine', item_id: null },
    ],
    default: 'keep',
    expires_at: null,
    state: 'open',
  };

  it('the question in the banner, «Оставить мои» first; nothing changed; a tap goes as `choice`', async () => {
    await setup();
    s.on('POST /chat/messages', (c) =>
      (c.body as { choice?: unknown }).choice ? { status: 200, sse: actionReply() } : { status: 200, sse: proposalReply(manual, 'confirm_manual') },
    );
    await say('разложи по темам');
    await settle(() => screen.queryByTestId('proposal-text') !== null);
    const banner = within(screen.getByTestId('answer-banner'));
    expect(banner.getByText('Вы сами расставили 4 записи. Переставить и их?')).toBeTruthy();
    const labels = banner.getAllByRole('button').map((b) => b.props.accessibilityLabel);
    expect(labels).toEqual(['Оставить мои', 'Да']);
    expect(screen.queryByTestId('group-Ремонт')).toBeNull();
    expect(s.callsTo('POST /actions/*/undo')).toHaveLength(0);

    await fireEvent.press(screen.getByTestId('proposal-keep'));
    await settle(() => s.callsTo('POST /chat/messages').length === 2);
    const body = s.callsTo('POST /chat/messages')[1]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ text: 'Оставить мои', choice: { reply_id: 'r1', option: 'keep' }, page_id: NOTES_SRV });
    expect(body.client_id).not.toBe((s.callsTo('POST /chat/messages')[0]?.body as { client_id: string }).client_id);
  });

  it('«Да» is sent only when tapped', async () => {
    await setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: proposalReply(manual, 'confirm_manual') }));
    await say('разложи по темам');
    await settle(() => screen.queryByTestId('proposal-yes') !== null);
    await fireEvent.press(screen.getByTestId('proposal-yes'));
    await settle(() => s.callsTo('POST /chat/messages').length === 2);
    expect(s.callsTo('POST /chat/messages')[1]?.body).toMatchObject({ text: 'Да', choice: { reply_id: 'r1', option: 'yes' } });
  });
});

describe('US-30: «это / здесь» — asked back, never guessed', () => {
  const which = {
    kind: 'choice',
    question: 'Какую?',
    count: null,
    item_ids: [],
    options: [
      { id: 'o1', label: 'Последнюю: «Заметка 12»', kind: 'item', item_id: 'srv-n12' },
      { id: 'pick', label: 'Выбрать', kind: 'pick', item_id: null },
      { id: 'cancel', label: 'Отмена', kind: 'cancel', item_id: null },
    ],
    default: null,
    expires_at: null,
    state: 'open',
  };

  it('«Какую?» with 3 options; an option goes as `choice` with its label', async () => {
    await setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: proposalReply(which, 'needs_choice') }));
    await say('удали это');
    await settle(() => screen.queryByTestId('proposal-o1') !== null);
    expect(screen.getByText('Какую?')).toBeTruthy();
    expect(screen.getByTestId('proposal-pick')).toBeTruthy();
    expect(screen.getByTestId('proposal-cancel')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('proposal-o1'));
    await settle(() => s.callsTo('POST /chat/messages').length === 2);
    expect(s.callsTo('POST /chat/messages')[1]?.body).toMatchObject({ text: 'Последнюю: «Заметка 12»', choice: { reply_id: 'r1', option: 'o1' } });
  });

  it('«Выбрать» → tap a record: the original phrase again, with that record, no `choice`', async () => {
    await setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: proposalReply(which, 'needs_choice') }));
    const r = await say('удали это');
    await settle(() => screen.queryByTestId('proposal-pick') !== null);
    await fireEvent.press(screen.getByTestId('proposal-pick'));
    expect(screen.getByTestId('pick-hint')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('record-n7'));
    await settle(() => s.callsTo('POST /chat/messages').length === 2);
    const body = s.callsTo('POST /chat/messages')[1]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ text: 'удали это', selected_item_id: 'srv-n7' });
    expect(body).not.toHaveProperty('choice');
    expect(r.getPathname()).toBe(`/page/${notes().id}`); // the tap did not open the card
  });
});

describe('without the server', () => {
  it('offline: a change says it needs the internet [Хорошо]; nothing is saved as a note', async () => {
    const outbox = await setup();
    s.offline = true;
    await say('разложи по темам');
    await settle(() => screen.queryByText('Сделать это смогу, когда появится интернет.') !== null);
    expect(screen.getByTestId('answer-ok')).toBeTruthy();
    expect(outbox.all().filter((e) => e.kind === 'item.create')).toHaveLength(0);
  });

  it('«Без ИИ»: no call to the conversation; a change is not possible, a note is saved', async () => {
    const outbox = await setup({ mode: 'no_ai' });
    await say('разложи по темам');
    await settle(() => screen.queryByTestId('answer-notice') !== null);
    expect(screen.getByText(/нужно согласие/)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'хлеб и молоко');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => outbox.all().some((e) => e.kind === 'item.create'));
    expect(s.callsTo('POST /chat/messages')).toHaveLength(0);
  });
});

describe('6.11: the answer waits on «Сегодня»; push «Ответ готов»', () => {
  const waiting = {
    id: 'r9',
    client_id: null,
    role: 'assistant',
    reply_to: 'u9',
    page: notesRef,
    input_kind: 'typed',
    text: '120 000 ₸ до 20 ноября.',
    answer_kind: 'text',
    state: 'done',
    citations: [],
    checked: { ok: true, removed: 0 },
    delivery: 'banner_pending',
    ai_label: 'Подготовил помощник (ИИ) — проверьте',
    action: null,
    proposal: null,
    choice: null,
    error_code: null,
    seq: 9,
    created_at: '2026-11-07T14:20:00Z',
  };

  it('«Ответ готов» card: banner_shown, then «Открыть ответ» → Переписка on it, opened', async () => {
    await setup();
    s.on('GET /chat/pending-banner', () => ({ status: 200, body: { message: waiting } }));
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('pending-answer') !== null);
    expect(within(screen.getByTestId('pending-answer')).getByText('Ответ готов')).toBeTruthy();
    expect(screen.getByText('120 000 ₸ до 20 ноября.')).toBeTruthy();
    await settle(() => s.callsTo('POST /chat/messages/r9/delivery').length > 0);
    expect(s.callsTo('POST /chat/messages/r9/delivery')[0]?.body).toEqual({ delivery: 'banner_shown' });
    await fireEvent.press(screen.getByTestId('pending-open'));
    await settle(() => r.getPathname() === '/chat');
    await settle(() => s.callsTo('POST /chat/messages/r9/delivery').some((c) => (c.body as { delivery: string }).delivery === 'opened'));
  });

  it('left the page while the answer was written: it is not on the other page, it is on «Сегодня»', async () => {
    await setup();
    usePages.getState().addPage('shopping');
    s.on('POST /chat/messages', () => ({ status: 200, sse: seqd([
      { event: 'accepted', data: { message_id: 'u1', reply_id: 'r1' } },
      { event: 'token', data: { text: 'Ответ.' } },
      { event: 'banner', data: { reply_id: 'r1', text: 'Ответ.', preview: 'Ответ.', short: true, ai_label: null, citations: [] } },
      { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'text', delivery: 'streamed', limited: false } },
    ]), chunkDelayMs: 100 }));
    await say('сколько я потратил?');
    const shopping = usePages.getState().pages.find((p) => p.templateKey === 'shopping')!;
    await act(() => router.navigate(`/page/${shopping.id}`));
    await settle(() => lastAnswer()?.status === 'done', 2000);
    expect(screen.queryByTestId('answer-banner')).toBeNull();
    await act(() => router.navigate('/'));
    await settle(() => screen.queryByTestId('answer-banner') !== null);
  });

  it('push: the token goes with the device once allowed; a tap opens Переписка on the reply', async () => {
    await setup();
    testPush.allowed = true;
    s.on('GET /chat/messages/*', () => ({ status: 200, body: waiting }));
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => s.callsTo('POST /devices').some((c) => (c.body as { push_token?: string }).push_token === 'fake-token'));
    expect(s.callsTo('POST /devices').at(-1)?.body).toMatchObject({ push_provider: 'fcm' });
    expect(testPush.quiet).toBe(true);
    testPush.open({ type: 'chat_reply', reply_id: 'r9' });
    await settle(() => r.getPathname() === '/chat');
    expect(screen.getByText('120 000 ₸ до 20 ноября.')).toBeTruthy();
  });
});
