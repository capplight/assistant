import { fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';

import { decodeChatEvent } from '@/api/endpoints';
import { SseParser } from '@/api/sse';
import i18n from '@/i18n';
import { chatTiming, flushQueued } from '@/chat/service';
import { getSyncEngine } from '@/services';
import { useAssistant } from '@/store/assistant';
import { usePages } from '@/store/pages';
import type { FakeServer, SseEvent } from '@/testing/fakeServer';
import { happyServer, itemOut } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testRecords } from '@/testing/helpers';

const NOTES_SRV = 'srv-notes';
const SHOP_SRV = 'srv-shop';
const AI_LABEL = 'Подготовил помощник (ИИ) — проверьте';

const page = (key: string) => usePages.getState().pages.find((p) => p.templateKey === key)!;

/** Pages with server ids: Заметки (seed) and Покупки (added), as after a sync. */
function withPages() {
  usePages.getState().addPage('shopping');
  usePages.setState({
    pages: usePages.getState().pages.map((p) =>
      p.templateKey === 'notes' ? { ...p, serverId: NOTES_SRV } : p.templateKey === 'shopping' ? { ...p, serverId: SHOP_SRV } : p,
    ),
  });
}

const notesRef = { id: NOTES_SRV, title: 'Заметки', icon: 'documents' };
const source = { ref: 's1', item_id: 'srv-erlan', title: 'Ерлан, ремонт', snippet: 'Ерлан, ремонт, 120 000 до 20-го', kind: 'note', occurred_at: '2026-11-03T09:00:00Z', page: notesRef, pages: [notesRef] };
const citation = { ref: 's1', item_id: 'srv-erlan', chunk_id: null, page: notesRef, title: 'Ерлан, ремонт', label: 'Заметки · Ерлан, ремонт, 3 ноя', occurred_at: '2026-11-03T09:00:00Z' };
const ANSWER = '120 000 ₸ до 20 ноября.';

/** A whole reply as docs/api/chat.md orders it. */
function reply(replyId = 'r1', text = [ANSWER], from = 1): SseEvent[] {
  const events: Omit<SseEvent, 'id'>[] = [
    { event: 'accepted', data: { message_id: `u-${replyId}`, reply_id: replyId, created_at: '2026-11-07T14:20:00Z' } },
    { event: 'status', data: { stage: 'searching', text: 'Смотрю записи…' } },
    { event: 'sources', data: { sources: [source] } },
    ...text.map((t) => ({ event: 'token', data: { text: t } })),
    { event: 'citations', data: { citations: [citation] } },
    { event: 'checked', data: { ok: true, removed: 0 } },
    { event: 'banner', data: { reply_id: replyId, text: text.join(''), preview: text.join(''), short: true, ai_label: AI_LABEL, citations: [citation] } },
    { event: 'done', data: { reply_id: replyId, state: 'done', answer_kind: 'text', delivery: 'streamed', limited: false } },
  ];
  return events.map((e, i) => ({ ...e, id: from + i }));
}

let s: FakeServer;

function setup(o: { mode?: 'full' | 'no_ai' } = {}) {
  s = happyServer();
  const outbox = resetApp({ fetch: s.fetch });
  finishOnboarding(o.mode ?? 'full');
  withPages();
  return outbox;
}

async function erlanRecord() {
  await testRecords.applyRemote(itemOut('erlan', 2, { text: 'Ерлан, ремонт, 120 000 до 20-го', status: 'ready' }));
}

async function askOnShopping(q = 'сколько я должна Ерлану?') {
  const r = await renderRouter(APP_DIR, { initialUrl: `/page/${page('shopping').id}` });
  await fireEvent.changeText(screen.getByTestId('assistant-input'), q);
  await fireEvent.press(screen.getByTestId('assistant-send'));
  return r;
}

const lastAnswer = () => useAssistant.getState().messages.filter((m) => m.role === 'assistant').at(-1);

const savedBackoff = chatTiming.resumeBackoffMs;
beforeEach(() => {
  chatTiming.resumeBackoffMs = [20, 20];
});
afterAll(() => {
  chatTiming.resumeBackoffMs = savedBackoff;
});

describe('SSE framing', () => {
  it('events split across chunks, CRLF, keep-alives; the last id carries over', () => {
    const p = new SseParser();
    expect(p.push('id: 3\r\nevent: tok')).toEqual([]);
    expect(p.push('en\r\ndata: {"text":"а"}\r\n\r\n: ping\n\nevent: done\ndata: {}\n')).toEqual([
      { event: 'token', data: '{"text":"а"}', id: '3' },
    ]);
    expect(p.end()).toEqual([{ event: 'done', data: '{}', id: '3' }]);
  });

  it('decodes the contract events; unknown ones are ignored', () => {
    expect(decodeChatEvent({ event: 'accepted', data: '{"message_id":"m","reply_id":"r"}', id: '1' })).toEqual({
      type: 'accepted',
      messageId: 'm',
      replyId: 'r',
      eventId: '1',
    });
    expect(decodeChatEvent({ event: 'citations', data: JSON.stringify({ citations: [citation] }), id: '5' })).toMatchObject({
      type: 'citations',
      citations: [{ ref: 's1', item_id: 'srv-erlan', label: 'Заметки · Ерлан, ремонт, 3 ноя', page: { id: NOTES_SRV } }],
    });
    expect(decodeChatEvent({ event: 'error', data: '{"code":"stream_interrupted","retry":true}', id: null })).toMatchObject({
      type: 'error',
      code: 'stream_interrupted',
      retry: true,
    });
    for (const event of ['action', 'page_patch', 'needs_choice', 'general_answer_offer']) {
      expect(decodeChatEvent({ event, data: '{}', id: null })).toBeNull();
    }
  });
});

describe('US-25: a question on one page, the answer with a source from another', () => {
  it('on «Покупки»: banner with the answer, the source in «Заметки», the AI label; nothing saved, the page unchanged', async () => {
    const outbox = setup();
    await erlanRecord();
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply() }));
    await askOnShopping();
    await settle(() => lastAnswer()?.status === 'done');

    const body = s.callsTo('POST /chat/messages')[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ text: 'сколько я должна Ерлану?', page_id: SHOP_SRV, lang: 'ru', input_kind: 'typed' });
    expect(body.client_id).toBe(useAssistant.getState().messages.find((m) => m.role === 'user')?.id);
    expect(body).not.toHaveProperty('scope');
    expect(s.callsTo('POST /chat/messages')[0]?.headers.Accept).toBe('text/event-stream');

    const banner = within(screen.getByTestId('answer-banner'));
    expect(banner.getByText(ANSWER)).toBeTruthy();
    expect(banner.getByText('Заметки · Ерлан, ремонт, 3 ноя')).toBeTruthy();
    expect(banner.getByText(AI_LABEL)).toBeTruthy();
    // A question is not a record, and nothing on «Покупки» changed.
    expect(outbox.all().filter((e) => e.kind === 'item.create')).toHaveLength(0);
    expect(screen.getByTestId('page-empty')).toBeTruthy();
    await settle(() => s.callsTo('POST /chat/messages/r1/delivery').length > 0);
    expect(s.callsTo('POST /chat/messages/r1/delivery')[0]?.body).toEqual({ delivery: 'banner_shown' });
  });

  it('the source opens the record on its page; «Назад к ответу» returns to «Покупки» with the banner', async () => {
    setup();
    await erlanRecord();
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply() }));
    const r = await askOnShopping();
    await settle(() => lastAnswer()?.status === 'done');
    await fireEvent.press(screen.getByTestId('source-srv-erlan'));
    await settle(() => r.getPathname() === '/record/erlan');
    expect(within(screen.getByTestId('context-chip')).getByText('Про: Заметки')).toBeTruthy();
    expect(screen.getByText('Ерлан, ремонт, 120 000 до 20-го')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('record-back'));
    await settle(() => r.getPathname() === `/page/${page('shopping').id}`);
    expect(within(screen.getByTestId('context-chip')).getByText('Про: Покупки')).toBeTruthy();
    expect(screen.getByTestId('answer-banner')).toBeTruthy();
  });

  it('a source not on the phone yet is fetched first', async () => {
    setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply() }));
    s.on('GET /items/*', () => ({ status: 200, body: itemOut('erlan', 4, { text: 'Ерлан, ремонт' }) }));
    const r = await askOnShopping();
    await settle(() => lastAnswer()?.status === 'done');
    await fireEvent.press(screen.getByTestId('source-srv-erlan'));
    await settle(() => r.getPathname() === '/record/erlan');
    expect(s.callsTo('GET /items/srv-erlan').length).toBeGreaterThanOrEqual(1);
  });
});

describe('US-26: banner → «Открыть ответ» → «Переписка»', () => {
  it('opens on the answer: divider by page, the question, the whole answer, sources, the label; «Свернуть» closes the banner', async () => {
    setup();
    await erlanRecord();
    const long = ['На ремонт в ноябре ушло 186 400 ₸. ', 'Ерлану вы должны 120 000 ₸ до 20 ноября. ', 'Плитки осталось купить около 8 м².'];
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply('r1', long) }));
    const r = await askOnShopping();
    await settle(() => lastAnswer()?.status === 'done');
    await fireEvent.press(screen.getByTestId('answer-open'));
    await settle(() => r.getPathname() === '/chat');
    expect(screen.getByText(/^— на странице Покупки, /)).toBeTruthy();
    expect(screen.getByLabelText('Вы: сколько я должна Ерлану?')).toBeTruthy();
    expect(screen.getByText(long.join(''))).toBeTruthy();
    expect(screen.getByText('Подготовил помощник (ИИ) по вашим записям — проверьте')).toBeTruthy();
    expect(screen.getByTestId('source-srv-erlan')).toBeTruthy();
    await settle(() => s.callsTo('POST /chat/messages/r1/delivery').some((c) => (c.body as { delivery: string }).delivery === 'opened'));

    await fireEvent.press(screen.getByTestId('chat-collapse'));
    await settle(() => r.getPathname() === `/page/${page('shopping').id}`);
    expect(screen.queryByTestId('answer-banner')).toBeNull();
  });

  it('streams: the banner shows what is being done, then the text grows', async () => {
    setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply('r1', ['Первое. ', 'Второе.']), chunkDelayMs: 200 }));
    await askOnShopping();
    await settle(() => screen.queryByText('Смотрю записи…') !== null);
    await settle(() => screen.queryByText('Первое.') !== null || screen.queryByText('Первое. ') !== null);
    expect(lastAnswer()?.status).toBe('streaming');
    await settle(() => lastAnswer()?.status === 'done', 2000);
    expect(lastAnswer()?.text).toBe('Первое. Второе.');
  });

  it('a new question replaces the banner and marks the old one closed', async () => {
    setup();
    let n = 0;
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply(`r${++n}`) }));
    await askOnShopping();
    await settle(() => lastAnswer()?.status === 'done');
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'где чек?');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => lastAnswer()?.serverId === 'r2' && lastAnswer()?.status === 'done');
    expect(s.callsTo('POST /chat/messages/r1/delivery').map((c) => (c.body as { delivery: string }).delivery)).toContain('dismissed');
    expect(useAssistant.getState().banner?.messageId).toBe(lastAnswer()?.id);
  });

  it('history from the server fills «Переписка» and completes an answer the phone did not get whole', async () => {
    setup();
    // The phone lost the stream after the first sentence and gave up.
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply('r1', ['Половина. ']).slice(0, 4), drop: 'end' }));
    s.on('GET /chat/messages/r1/events', () => 'offline');
    const r = await askOnShopping();
    await settle(() => lastAnswer()?.status === 'interrupted');
    const q = useAssistant.getState().messages.find((m) => m.role === 'user')!;
    s.on('GET /chat/messages', () => ({
      status: 200,
      body: {
        messages: [
          { id: 'u-r1', client_id: q.id, role: 'user', reply_to: null, page: { id: SHOP_SRV, title: 'Покупки', icon: 'cart' }, text: q.text, state: 'done', citations: [], ai_label: null, created_at: q.at },
          { id: 'r1', client_id: null, role: 'assistant', reply_to: 'u-r1', page: { id: SHOP_SRV, title: 'Покупки', icon: 'cart' }, text: 'Половина. Целиком.', answer_kind: 'text', state: 'done', citations: [citation], ai_label: AI_LABEL, created_at: q.at },
          { id: 'r0', client_id: null, role: 'assistant', reply_to: 'u-r0', page: null, text: 'С другого телефона.', answer_kind: 'text', state: 'done', citations: [], ai_label: AI_LABEL, created_at: '2026-11-01T10:00:00Z' },
        ],
        has_more_before: false,
        has_more_after: false,
      },
    }));
    await fireEvent.press(screen.getByTestId('answer-open'));
    await settle(() => r.getPathname() === '/chat');
    await settle(() => screen.queryByText('Половина. Целиком.') !== null);
    expect(screen.getByText('С другого телефона.')).toBeTruthy();
    expect(useAssistant.getState().messages.filter((m) => m.role === 'assistant' && m.serverId === 'r1')).toHaveLength(1);
  });
});

describe('a dropped stream', () => {
  it('resumes with Last-Event-ID and keeps what came; the text is not doubled', async () => {
    setup();
    const all = reply('r1', ['Сто двадцать тысяч. ', 'До двадцатого.']);
    // accepted, status, sources, first token — then the connection goes quiet and closes.
    s.on('POST /chat/messages', () => ({ status: 200, sse: all.slice(0, 4), drop: 'error' }));
    s.on('GET /chat/messages/r1/events', () => ({ status: 200, sse: all.slice(4) }));
    await askOnShopping();
    await settle(() => lastAnswer()?.status === 'done');
    const resume = s.callsTo('GET /chat/messages/r1/events');
    expect(resume).toHaveLength(1);
    expect(resume[0]?.headers['Last-Event-ID']).toBe('4');
    expect(lastAnswer()?.text).toBe('Сто двадцать тысяч. До двадцатого.');
    expect(s.callsTo('POST /chat/messages')).toHaveLength(1);
  });

  it('a finished reply comes back as a snapshot', async () => {
    setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply().slice(0, 3), drop: 'end' }));
    s.on('GET /chat/messages/r1/events', () => ({
      status: 200,
      sse: [
        { id: 1, event: 'accepted', data: { message_id: 'u-r1', reply_id: 'r1' } },
        { id: 2, event: 'snapshot', data: { message: { id: 'r1', role: 'assistant', text: ANSWER, state: 'done', citations: [citation], ai_label: AI_LABEL } } },
        { id: 3, event: 'done', data: { reply_id: 'r1', state: 'done', limited: false } },
      ],
    }));
    await askOnShopping();
    await settle(() => lastAnswer()?.status === 'done');
    expect(lastAnswer()?.text).toBe(ANSWER);
    expect(lastAnswer()?.sources?.[0]?.label).toBe('Заметки · Ерлан, ремонт, 3 ноя');
  });

  it('cut before `accepted` and still gone: «Связь прервалась» + «Спросить ещё раз», the same turn again', async () => {
    setup();
    let calls = 0;
    s.on('POST /chat/messages', () => (++calls <= 3 ? { status: 200, sse: [], drop: 'error' } : { status: 200, sse: reply() }));
    await askOnShopping();
    await settle(() => lastAnswer()?.status === 'interrupted');
    expect(within(screen.getByTestId('answer-banner')).getByText('Связь прервалась — ответ не дошёл.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('answer-retry'));
    await settle(() => lastAnswer()?.status === 'done');
    const ids = s.callsTo('POST /chat/messages').map((c) => (c.body as { client_id: string }).client_id);
    expect(new Set(ids).size).toBe(1);
  });

  it('`error` with retry: «Спросить ещё раз» sends a new client_id', async () => {
    setup();
    let calls = 0;
    s.on('POST /chat/messages', () =>
      ++calls === 1
        ? {
            status: 200,
            sse: [
              { id: 1, event: 'accepted', data: { message_id: 'u1', reply_id: 'r1' } },
              { id: 2, event: 'error', data: { reply_id: 'r1', code: 'stream_interrupted', message_ru: '', message_kk: '', retry: true } },
            ],
          }
        : { status: 200, sse: reply('r2') },
    );
    await askOnShopping();
    await settle(() => lastAnswer()?.status === 'interrupted');
    await fireEvent.press(screen.getByTestId('answer-retry'));
    await settle(() => lastAnswer()?.status === 'done');
    const ids = s.callsTo('POST /chat/messages').map((c) => (c.body as { client_id: string }).client_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(lastAnswer()?.serverId).toBe('r2');
  });
});

describe('offline, limits, «Без ИИ»', () => {
  it('offline: what the phone has at once, «Спрошу, когда появится интернет», asked when the connection is back', async () => {
    setup();
    await erlanRecord();
    s.offline = true;
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply() }));
    const r = await askOnShopping('где Ерлан?');
    await settle(() => lastAnswer()?.status === 'queued');
    const banner = within(screen.getByTestId('answer-banner'));
    expect(banner.getByText('Спрошу, когда появится интернет.')).toBeTruthy();
    expect(banner.getByText('На телефоне нашёл: 1')).toBeTruthy();
    await settle(() => screen.queryByTestId('local-hit-erlan') !== null);
    await fireEvent.press(screen.getByTestId('local-hit-erlan'));
    await settle(() => r.getPathname() === '/record/erlan');

    s.offline = false;
    await flushQueued();
    await settle(() => lastAnswer()?.status === 'done');
    expect(lastAnswer()?.text).toBe(ANSWER);
  });

  it('the monthly limit: the honest line, no made-up answer', async () => {
    setup();
    s.on('POST /chat/messages', () => ({
      status: 200,
      sse: [
        { id: 1, event: 'accepted', data: { message_id: 'u1', reply_id: 'r1' } },
        { id: 2, event: 'citations', data: { citations: [citation] } },
        { id: 3, event: 'done', data: { reply_id: 'r1', state: 'done', limited: true } },
      ],
    }));
    await askOnShopping();
    await settle(() => lastAnswer()?.status === 'done');
    expect(screen.getByText('На сегодня достаточно — продолжу завтра. Сохранение и поиск работают.')).toBeTruthy();
    expect(screen.queryByText(AI_LABEL)).toBeNull();
  });

  it('no consent for the AI services on the server: says so, does not retry', async () => {
    setup();
    s.on('POST /chat/messages', () => ({
      status: 403,
      body: { code: 'consent_required', message_ru: '', message_kk: '', details: { missing: ['ai_cross_border'] } },
    }));
    await askOnShopping();
    await settle(() => lastAnswer()?.status === 'failed');
    expect(screen.getByText('Чтобы отвечать на вопросы, нужно согласие. Поиск по словам работает.')).toBeTruthy();
  });

  it('«Без ИИ»: a question is a search by words; /chat is never called', async () => {
    setup({ mode: 'no_ai' });
    const r = await askOnShopping();
    await settle(() => r.getPathname() === '/search');
    expect(s.callsTo('POST /chat/messages')).toHaveLength(0);
    await flushQueued();
    expect(s.calls.some((c) => c.path.startsWith('/chat'))).toBe(false);
  });

  it('week 6: a note goes to the conversation (the server decides); never reached it → saved on the phone (week 9: on «Покупки» as a row of the list)', async () => {
    const outbox = setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply() }));
    await askOnShopping('хлеб и молоко');
    await settle(() => s.callsTo('POST /chat/messages').length === 1);
    expect(outbox.all().filter((e) => e.kind === 'item.create')).toHaveLength(0);

    s.offline = true;
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'сыр и масло');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => outbox.all().some((e) => e.kind === 'task.create'));
    expect(outbox.all().filter((e) => e.kind === 'item.create')).toHaveLength(0);
    expect(within(screen.getByTestId('answer-banner')).getByText(/^Сохранил\./)).toBeTruthy();
  });
});

describe('«Сообщить о проблеме»', () => {
  it('«Ещё» → reason, comment; the example box is off unless ticked; goes through the outbox to /feedback', async () => {
    const outbox = setup();
    s.on('POST /chat/messages', () => ({ status: 200, sse: reply() }));
    const r = await askOnShopping();
    await settle(() => lastAnswer()?.status === 'done');
    await fireEvent.press(screen.getByTestId('answer-open'));
    await settle(() => r.getPathname() === '/chat');
    await fireEvent.press(screen.getByTestId(`chat-more-${lastAnswer()!.id}`));
    await fireEvent.press(screen.getByTestId('answer-report'));
    await settle(() => screen.queryByTestId('feedback-sheet') !== null);
    expect(screen.getByTestId('feedback-allow').props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(screen.getByTestId('feedback-reason-wrong'));
    await fireEvent.changeText(screen.getByTestId('feedback-comment'), '  Сумма не та ');
    await fireEvent.press(screen.getByTestId('feedback-send'));
    await settle(() => outbox.all().some((e) => e.kind === 'feedback.send'));
    await (await getSyncEngine()).push();
    const sent = s.callsTo('POST /feedback');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      target: 'answer',
      target_ref: 'r1',
      reason: 'wrong',
      comment: 'Сумма не та',
      allow_anonymized_example: false,
    });
    expect(sent[0]?.headers['Idempotency-Key']).toBe((sent[0]?.body as { client_id: string }).client_id);
  });
});

describe('first launch copy (S41 / S03) and line hints', () => {
  it('no reminder promised in examples; hints show a question where questions work', async () => {
    resetApp();
    useAssistant.getState().reset();
    const { t } = i18n;
    expect(t('start.phrase_example')).not.toMatch(/[Нн]апомн/);
    expect(t('phrase.ex1')).not.toMatch(/[Нн]апомн/);
    expect(t('start.phrase_typed')).toBe('Напишите одну фразу');
    expect(t('tpl.line_hint_now.today')).toBe('Например: где мой чек за холодильник?');
  });
});
