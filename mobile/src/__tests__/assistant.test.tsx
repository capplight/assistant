import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';

import { aiConsentOutdated } from '@/consent/AiConsentUpdate';
import { AI_CONSENT_VERSION, BUNDLED_CONSENT_TEXTS } from '@/consent/texts';
import { PLAN_PHRASE } from '@/components/AssistantLine';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { useConnectivity } from '@/store/connectivity';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { happyServer, type FakeServer, type SseEvent } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';

/**
 * VISION-2026-11 step 2: the centre «Помощник» tab — one conversation, the same as the small line on other tabs
 * (v4 «Помощник · первый раз», «Чат — центр», «Без связи»), and the AI consent v2 (+ DeepInfra) as a small sheet.
 */
const NOTES_SRV = 'srv-notes';
const page = (key: string) => usePages.getState().pages.find((p) => p.templateKey === key)!;
const seqd = (events: Omit<SseEvent, 'id'>[]): SseEvent[] => events.map((e, i) => ({ ...e, id: i + 1 }));
const iso = () => new Date().toISOString();

let s: FakeServer;
function setup() {
  s = happyServer();
  resetApp({ fetch: s.fetch });
  finishOnboarding('full');
  usePages.setState({ pages: usePages.getState().pages.map((p) => (p.templateKey === 'notes' ? { ...p, serverId: NOTES_SRV } : p)) });
}

function textReply(text: string): SseEvent[] {
  return seqd([
    { event: 'accepted', data: { message_id: 'u-r1', reply_id: 'r1', created_at: iso() } },
    { event: 'token', data: { text } },
    { event: 'banner', data: { reply_id: 'r1', text, preview: text, short: true, ai_label: null, citations: [] } },
    { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'text', delivery: 'streamed', limited: false } },
  ]);
}

function threeThings(): SseEvent[] {
  const change = (id: string, title: string) => ({ item_id: id, key: null, kind: 'create', title, text: title, page_id: NOTES_SRV, reverted: false });
  const action = {
    id: 'a3', kind: 'save_item', scope: 'internal', initiated_by: 'agent', summary: { ru: 'Сделал 3 дела', kk: null },
    page: { id: NOTES_SRV, title: 'Заметки', icon: 'documents' },
    changes: [change('srv-1', 'Кофе — 1 200 ₸'), change('srv-2', 'Позвонить в банк'), change('srv-3', 'Код домофона 4512')],
    changed_item_ids: ['srv-1', 'srv-2', 'srv-3'], created_page_id: null, undoable: true, undoable_until: null, undone_at: null, undo_of: null,
    message_id: null, seq: 10, created_at: iso(),
  };
  return seqd([
    { event: 'accepted', data: { message_id: 'u-r1', reply_id: 'r1', created_at: iso() } },
    { event: 'action', data: { reply_id: 'r1', action, changed_item_ids: action.changed_item_ids, page_id: NOTES_SRV } },
    { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'action', action_id: 'a3', delivery: 'streamed', limited: false } },
  ]);
}

describe('«Помощник» — the centre tab', () => {
  beforeEach(setup);

  it('a new conversation: «новый разговор», the tagline, four examples; an example puts its phrase in the line', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.press(screen.getByTestId('tab-assistant'));
    expect(r.getPathname()).toBe('/assistant');
    expect(screen.getByTestId('tab-assistant')).toBeSelected();
    // v5 «Помощник · первый раз»: no small text on the terracotta strip; the big line and four example rows.
    expect(screen.queryByTestId('assistant-subtitle')).toBeNull();
    expect(screen.getByTestId('chat-tagline')).toHaveTextContent('Скажите или перешлите — я разложу по местам и найду, когда понадобится.');
    for (const k of ['note', 'spend', 'task', 'find']) expect(screen.getByTestId(`chat-example-${k}`)).toBeTruthy();
    expect(screen.getByText('Ваши записи видите только вы')).toBeTruthy();
    expect(screen.getByTestId('assistant-input').props.placeholder).toBe('Спросите или запишите…');
    await fireEvent.press(screen.getByTestId('chat-example-find'));
    await settle(() => screen.getByTestId('assistant-input').props.value === 'Что мне советовали про ');
  });

  it('asked in the chat: the question on the right, the answer below it — no small banner here', async () => {
    s.on('POST /chat/messages', () => ({ status: 200, sse: textReply('Код домофона — 4512, подъезд 3.') }));
    await renderRouter(APP_DIR, { initialUrl: '/assistant' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'где мамин код?');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => screen.queryByText('Код домофона — 4512, подъезд 3.') !== null);
    const q = useAssistant.getState().messages.find((m) => m.role === 'user')!;
    expect(q.pageId).toBe('assistant');
    expect(screen.getByTestId(`chat-user-${q.id}`)).toHaveTextContent('где мамин код?');
    expect(screen.queryByTestId(`chat-user-${q.id}-from`)).toBeNull();
    expect(screen.queryByTestId('answer-banner')).toBeNull();
    expect(s.callsTo('POST /chat/messages')).toHaveLength(1);
  });

  it('one phrase → three things: «Сделал 3 дела», a row each, «Переложить · Отменить всё»', async () => {
    s.on('POST /chat/messages', () => ({ status: 200, sse: threeThings() }));
    await renderRouter(APP_DIR, { initialUrl: '/assistant' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'кофе 1200, завтра в 9 позвонить в банк и запомни код 4512');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    const answer = () => useAssistant.getState().messages.find((m) => m.role === 'assistant');
    await settle(() => !!answer()?.action);
    const card = within(screen.getByTestId(`chat-action-${answer()!.id}`));
    expect(card.getByText('Сделал 3 дела')).toBeTruthy();
    for (const i of [0, 1, 2]) expect(card.getByTestId(`chat-action-row-${i}`)).toBeTruthy();
    expect(card.getByText('Позвонить в банк')).toBeTruthy();
    expect(card.getByTestId(`chat-undo-${answer()!.id}`)).toHaveTextContent('Отменить всё');
    // The card carries the undo; no second strip under it.
    expect(screen.queryByTestId('undo-strip-undo')).toBeNull();
    await fireEvent.press(card.getByTestId(`chat-undo-${answer()!.id}`));
    await settle(() => s.callsTo('POST /actions/a3/undo').length === 1);
  });

  it('the small line on «Заметки» writes into the same conversation: «Продолжить в чате» shows it «с вкладки «Заметки»»', async () => {
    s.on('POST /chat/messages', () => ({ status: 200, sse: textReply('Четыре совета про Стамбул в ваших заметках, чаще всего — кофе в Бейоглу.') }));
    const r = await renderRouter(APP_DIR, { initialUrl: `/page/${page('notes').id}` });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'что советовали про Стамбул?');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => screen.queryByTestId('answer-open') !== null);
    expect(screen.getByTestId('answer-open')).toHaveTextContent('Продолжить в чате ›');
    await fireEvent.press(screen.getByTestId('answer-open'));
    await settle(() => r.getPathname() === '/assistant');
    const q = useAssistant.getState().messages.find((m) => m.role === 'user')!;
    expect(screen.getByTestId(`chat-user-${q.id}-from`)).toHaveTextContent('с вкладки «Заметки»');
    expect(screen.getByText('Четыре совета про Стамбул в ваших заметках, чаще всего — кофе в Бейоглу.')).toBeTruthy();
  });

  it('«составь план…» said on «Сегодня» goes on in the chat', async () => {
    expect(PLAN_PHRASE.test('Составь план поездки в Стамбул')).toBe(true);
    expect(PLAN_PHRASE.test('разложи мои дела по ремонту кухни')).toBe(true);
    expect(PLAN_PHRASE.test('план этажа в заметки')).toBe(false);
    s.on('POST /chat/messages', () => ({ status: 200, sse: textReply('План поездки: 5 дней.') }));
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'составь план поездки в Стамбул');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => r.getPathname() === '/assistant');
    await settle(() => screen.queryByText('План поездки: 5 дней.') !== null);
    expect(useAssistant.getState().messages.find((m) => m.role === 'user')?.pageId).toBe('assistant');
  });

  it('offline: «нет связи» in the header and the banner «Всё, что скажете, сохраню и разберу позже»', async () => {
    const saved: ChatMessage = { id: 'm1', role: 'assistant', text: 'Сохранил.', saved: true, status: 'done', pageId: 'assistant', pageTitle: 'Помощник', at: iso() };
    const said: ChatMessage = { id: 'q1', role: 'user', text: 'такси до аэропорта 4 500', pageId: 'assistant', pageTitle: 'Помощник', at: iso() };
    useAssistant.setState({ messages: [said, saved] });
    await renderRouter(APP_DIR, { initialUrl: '/assistant' });
    await act(async () => useConnectivity.setState({ online: false }));
    // v5: «нет связи» is the cloud on the strip (no small text on terracotta), the words are on the paper.
    expect(screen.getByLabelText('нет связи')).toBeTruthy();
    expect(screen.getByTestId('chat-offline')).toHaveTextContent(/Нет связи/);
    expect(screen.getByText('сохранил как заметку · разберу позже')).toBeTruthy();
    expect(screen.getAllByText('Сегодня').length).toBeGreaterThan(1); // the day caption and the tab
    await act(async () => useConnectivity.setState({ online: true }));
  });

  it('QA v5-device-1 «Помощник»: a broken answer has «Повторить» (and the cloud offline); a trimmed head is not shown', async () => {
    const act1 = { id: 'x1', kind: 'save_item', text: 'Записал', textKk: null, pageServerId: null, pageTitle: 'Заметки', changedItemIds: [], changes: [], createdPageId: null, undoable: true, undone: false };
    const orphan: ChatMessage = { id: 'o1', role: 'assistant', text: '', status: 'done', pageId: 'assistant', pageTitle: 'Помощник', at: iso(), action: act1 as never };
    const q: ChatMessage = { id: 'q2', role: 'user', text: 'где паспорт', pageId: 'assistant', pageTitle: 'Помощник', at: iso() };
    const broken: ChatMessage = { id: 'b1', role: 'assistant', text: '', status: 'interrupted', pageId: 'assistant', pageTitle: 'Помощник', at: iso(), replyTo: 'q2' };
    useAssistant.setState({ messages: [orphan, q, broken] });
    await renderRouter(APP_DIR, { initialUrl: '/assistant' });
    // «Переложить · Отменить» of an answer whose question is gone does not hang on top.
    expect(screen.queryByTestId('chat-msg-o1')).toBeNull();
    expect(screen.queryByTestId('chat-undo-o1')).toBeNull();
    expect(screen.getByTestId('chat-retry-b1')).toHaveTextContent('Повторить');
    expect(screen.queryByTestId('chat-msg-b1-offline')).toBeNull();
    await act(async () => useConnectivity.setState({ online: false }));
    expect(screen.getByTestId('chat-msg-b1-offline')).toBeTruthy();
    await act(async () => useConnectivity.setState({ online: true }));
  });

  it('«Дела» left the tabs: «‹ Сегодня» on their page, a tile in «Ещё»', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/more' });
    expect(screen.getByTestId('more-tasks')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('more-tasks'));
    await settle(() => r.getPathname() === `/page/${page('tasks').id}`);
    // QA B «Дела» 6: opened from «Ещё» → «‹ Ещё» back to «Ещё».
    expect(screen.getByTestId('page-back')).toHaveTextContent(/Ещё/);
    await fireEvent.press(screen.getByTestId('page-back'));
    expect(r.getPathname()).toBe('/more');
  });
});

describe('AI consent v2 (+ DeepInfra, Ф-76)', () => {
  beforeEach(setup);

  it('the bundled snapshot is v2; a person on v1 gets a small sheet and «Согласен» records exactly v2', async () => {
    const ru = BUNDLED_CONSENT_TEXTS.find((x) => x.kind === 'ai_cross_border' && x.locale === 'ru')!;
    expect(ru.version).toBe(AI_CONSENT_VERSION);
    expect(ru.providers).toContain('DeepInfra');
    const v1 = { kind: 'ai_cross_border', version: 'ai-2026-11-v1', textHash: 'a51e', locale: 'ru' };
    useOnboarding.getState().acceptConsent('full', [v1]);
    expect(aiConsentOutdated()).toBe(true);
    const grant = { id: 'c1', kind: 'ai_cross_border', version: 'ai-2026-11-v1', providers: [], text_hash: 'a51e', locale: 'ru', screen: 'welcome', granted_at: iso(), revoked_at: null };
    s.on('GET /consents', () => ({ status: 200, body: { active: [grant], history: [], ai_enabled: true, app_enabled: true } }));
    s.on('GET /consents/text', () => ({
      status: 200,
      body: { kind: 'ai_cross_border', version: ru.version, locale: 'ru', text: ru.text, text_hash: ru.textHash, providers: ru.providers },
    }));
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('ai-consent-text') !== null);
    expect(screen.getByTestId('ai-consent-text')).toHaveTextContent(/DeepInfra/);
    await fireEvent.press(screen.getByTestId('ai-consent-accept'));
    await settle(() => s.callsTo('POST /consents').length === 1);
    expect(s.callsTo('POST /consents')[0]?.body).toMatchObject({
      consents: [{ kind: 'ai_cross_border', version: AI_CONSENT_VERSION, text_hash: ru.textHash, locale: 'ru' }],
    });
    await settle(() => !aiConsentOutdated());
    expect(screen.queryByTestId('ai-consent-text')).toBeNull();
  });
});
