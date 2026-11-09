import { router } from 'expo-router';

import { looksLikeReminder } from '@/alarms/format';
import { keepPhrase, parsePhrase } from '@/alarms/service';
import { answerReadyFrom } from '@/api/endpoints';
import { ApiError, NetworkError, SignInRequiredError } from '@/api/errors';
import { StreamDroppedError } from '@/api/sse';
import type {
  ActionOut,
  ChatCitationOut,
  ChatDeliveryState,
  ChatEvent,
  ChatMessageIn,
  ChatMessageOut,
  ChatSourceOut,
  FeedbackIn,
  FeedbackReason,
  PagePatchOut,
  ProposalOut,
  ReminderParseOut,
} from '@/api/types';
import { getOutbox, getPagesRepo, getRecords, isTrashed, titlesToGroups, type PageLink } from '@/db';
import i18n from '@/i18n';
import { guessLine, searchRecords } from '@/records/search';
import { LIST_LIMIT } from '@/records/useRecords';
import { fetchRecord, getApi, getCapture, kickSync, notifyDataChanged, syncBlocked } from '@/services';
import {
  useAssistant,
  type ChatAction,
  type ChatAskContext,
  type ChatMessage,
  type ChatNotice,
  type ChatProposal,
  type ChatSource,
  type ChatStatus,
  type LineGuess,
} from '@/store/assistant';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import type { ActionUndoPayload } from '@/sync/engine';
import { applyAssistantView, lookBefore, restoreLook, type SavedLook } from '@/pages/viewService';
import { addTask, listForPage, rememberActions, taskSink } from '@/tasks/service';
import { newId } from '@/utils/id';

/**
 * The single conversation (R-52, docs/api/chat.md): a phrase from the line on any page goes to
 * POST /chat/messages with what is on screen (`visible_item_ids`, `view_version`, `selected_item_id`)
 * and streams into one assistant message. A text answer shows in the banner; an action is already
 * on the page (`page_patch`, highlighted 600 ms) with «Что изменилось» / «Отменить» over the line;
 * «Какую?» and «Вы сами расставили…» are asked in the banner (US-24, US-28, US-30).
 * The week 6 event shapes are PROVISIONAL (src/api/types.ts).
 *
 * A dropped stream: resume with `Last-Event-ID` (GET …/events) at 1, 2, 4, 10 s; before `accepted`
 * the same POST again (same client_id = the same turn). Still nothing → «Связь прервалась» with
 * «Спросить ещё раз». Never reached the server → what the phone can do alone: a question waits for
 * the connection, a note is saved here, a change says it needs the internet.
 */

export type AskPage = { id: string; title: string; serverId: string | null };

/**
 * 3-engineering 5.10 п. 2: the server tells a question from a change or a note (INTENT on the
 * person's phrase), so online every phrase goes there. The phone's own guess (`guessLine`) is only
 * for when the server can't be asked. `serverDecides=false` goes back to week 5 routing (notes
 * saved on the phone, only questions and changes asked), for a server without the `create` tool.
 */
export const lineRouting = { serverDecides: true };

/** Offline: how many records found on the phone are shown under the question. */
const LOCAL_HITS = 5;

/** Reconnect delays after a drop (docs/api/chat.md «Resume»). Tests shorten them. */
export const chatTiming = { resumeBackoffMs: [1000, 2000, 4000, 10_000] };

const store = () => useAssistant.getState();
const find = (id: string) => store().messages.find((m) => m.id === id);

/** Nothing goes out before S05, in «Без ИИ», or while the account waits for consent / sign-in. */
export function chatAllowed(): boolean {
  const o = useOnboarding.getState();
  return o.consent !== null && !selectNoAi(o) && !syncBlocked();
}

function fromSource(s: ChatSourceOut): ChatSource {
  return {
    ref: s.ref,
    itemId: s.item_id,
    pageServerId: s.page?.id ?? null,
    pageTitle: s.page?.title ?? null,
    title: s.title,
    label: null,
    occurredAt: s.occurred_at,
  };
}

function fromCitation(c: ChatCitationOut): ChatSource {
  return {
    ref: c.ref,
    itemId: c.item_id,
    pageServerId: c.page?.id ?? null,
    pageTitle: c.page?.title ?? null,
    title: c.title,
    label: c.label,
    occurredAt: c.occurred_at,
  };
}

export function fromAction(a: ActionOut): ChatAction {
  return {
    id: a.id,
    kind: a.kind,
    text: a.summary.ru,
    textKk: a.summary.kk,
    pageServerId: a.page?.id ?? null,
    pageTitle: a.page?.title ?? null,
    changedItemIds: a.changed_item_ids,
    changes: a.changes.map((c) => ({ itemId: c.item_id, title: c.title, text: c.text, reverted: c.reverted, key: c.key ?? null })),
    createdPageId: a.created_page_id,
    undoable: a.undoable,
    undone: !!a.undone_at,
  };
}

function fromProposal(p: ProposalOut): ChatProposal {
  return {
    kind: p.kind,
    question: p.question,
    options: p.options.map((o) => ({ id: o.id, label: o.label, kind: o.kind, itemId: o.item_id })),
    defaultId: p.default,
    answered: p.state === 'open' ? null : p.state,
  };
}

/** The action's line in the app language (`summary.kk` is null until reviewed: then Russian). */
export const actionText = (a: ChatAction, lang: string): string => (lang === 'kk' && a.textKk ? a.textKk : a.text);

/** Records on the phone that match the question by words («Нашёл у себя»). */
async function localHits(text: string): Promise<string[]> {
  try {
    const all = (await (await getRecords()).list(LIST_LIMIT)).filter((r) => !isTrashed(r) && !r.hiddenReason);
    return searchRecords(all, text, LOCAL_HITS).map((r) => r.id);
  } catch {
    return [];
  }
}

/**
 * The answer is about a change (not a question): it may be finished by the server in the background
 * (chat.md `deferred`, week 10), so the phone never offers to send it again (that could do it twice).
 */
function isChange(m: ChatMessage | undefined): boolean {
  if (!m) return false;
  return m.answerKind === 'action' || !!m.action || find(m.replyTo ?? '')?.ask?.guess === 'action';
}

function apply(answerId: string, e: ChatEvent): void {
  const { updateMessage } = store();
  if (e.eventId) updateMessage(answerId, { lastEventId: e.eventId });
  switch (e.type) {
    case 'accepted':
      if (e.replyId) updateMessage(answerId, { serverId: e.replyId });
      return;
    case 'status':
      updateMessage(answerId, { activity: e.text });
      return;
    case 'sources':
      updateMessage(answerId, (m) => {
        const have = new Set((m.sources ?? []).map((s) => s.ref));
        return { sources: [...(m.sources ?? []), ...e.sources.filter((s) => !have.has(s.ref)).map(fromSource)] };
      });
      return;
    case 'token':
      updateMessage(answerId, (m) => ({ text: m.text + e.text, activity: null }));
      return;
    case 'citations':
      // The chips: only what the answer is based on (may be none).
      updateMessage(answerId, { sources: e.citations.map(fromCitation) });
      return;
    case 'checked':
      return; // removed sentences were never sent; the text already says so when it matters
    case 'banner':
      updateMessage(answerId, (m) => ({
        text: e.text || m.text,
        aiGenerated: e.aiLabel !== null,
        ...(e.citations.length > 0 ? { sources: e.citations.map(fromCitation) } : {}),
      }));
      return;
    case 'snapshot': {
      const s = e.message;
      updateMessage(answerId, {
        text: s.text,
        sources: s.citations.map(fromCitation),
        aiGenerated: s.ai_label !== null,
        serverId: s.id,
        answerKind: s.answer_kind,
        ...(s.action ? { action: fromAction(s.action) } : {}),
        ...(s.proposal ? { proposal: fromProposal(s.proposal) } : {}),
      });
      return;
    }
    case 'reminder_draft':
      openDraft(e.draft, e.replyId, undefined, e.createdVia);
      return;
    case 'action': {
      // Week 9: tasks it made show on «Покупки» / «Дела» at once, before /sync brings their records.
      if (e.tasks && e.tasks.length > 0) taskSink.applyServer(e.tasks);
      rememberActions([e.action]);
      // Several `action` events in one reply are the same action growing: replace it.
      const action = { ...fromAction(e.action), changedItemIds: e.changedItemIds };
      updateMessage(answerId, { action, answerKind: 'action', activity: null });
      // The result is on the page, not in a banner (R-52 п. 2); «Отменить» lives with the line.
      if (store().banner?.messageId === answerId) store().closeBanner();
      const strip = useUndo.getState().strip;
      if (strip?.kind !== 'action' || strip.messageId !== answerId) useUndo.getState().showAction(answerId);
      if (!patching.has(answerId)) useView.getState().showHighlight(action.changedItemIds);
      kickSync(); // docs/api/chat.md: the records themselves come with /v1/sync
      return;
    }
    case 'page_patch':
      queuePatch(answerId, e.patch);
      return;
    case 'proposal':
      // «Какую?», «Переставить 212 записей?», «Вы сами расставили…»: nothing was changed.
      updateMessage(answerId, { proposal: fromProposal(e.proposal), answerKind: 'choice', activity: null });
      store().showBanner({ messageId: answerId });
      return;
    case 'done':
      updateMessage(answerId, (m) => ({
        status: 'done',
        activity: null,
        serverId: e.replyId ?? m.serverId ?? null,
        notice: e.limited ? 'limit' : m.notice,
        answerKind: e.answerKind ?? m.answerKind ?? null,
      }));
      return;
    case 'deferred':
      updateMessage(answerId, (m) => ({
        status: 'deferred',
        activity: null,
        serverId: e.replyId ?? m.serverId ?? null,
        ...(isChange(m) ? { notice: 'maybe_done' as const } : {}),
      }));
      return;
    case 'error':
      updateMessage(answerId, (m) =>
        e.code === 'consent_required'
          ? { status: 'failed', activity: null, notice: 'no_ai' }
          : (e.code === 'stream_interrupted' || e.code === 'stale') && isChange(m)
            ? { status: 'interrupted', activity: null, notice: 'maybe_done', serverId: e.replyId ?? m.serverId ?? null }
            : e.retry
            ? { status: 'interrupted', activity: null, newTurn: true, serverId: e.replyId ?? m.serverId ?? null }
            : { status: 'failed', activity: null, notice: 'error' },
      );
      return;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function body(question: ChatMessage, answer: ChatMessage): ChatMessageIn {
  const page = usePages.getState().pages.find((p) => p.id === question.pageId);
  const c = question.ask;
  return {
    client_id: answer.turnId ?? question.id,
    text: question.text,
    page_id: page?.serverId ?? null,
    visible_item_ids: c?.visibleItemIds ?? [],
    view_version: c?.viewVersion ?? null,
    selected_item_id: c?.selectedItemId ?? null,
    lang: useOnboarding.getState().language,
    input_kind: 'typed',
    ...(c?.choice ? { choice: { reply_id: c.choice.replyId, option: c.choice.option } } : {}),
  };
}

/**
 * What is on screen on page `pageId` now (taken when the phrase is said, so a retry later sends
 * the same). «Это» = the open record card, else the page (1-product 6.11 п. 3).
 */
export function pageContext(pageId: string): Omit<ChatAskContext, 'guess'> {
  const page = usePages.getState().pages.find((p) => p.id === pageId);
  const v = useView.getState();
  return {
    visibleItemIds: page ? (v.visible[pageId] ?? []) : [],
    viewVersion: page?.serverId ? (page.viewVersion ?? null) : null,
    selectedItemId: v.selected,
  };
}

// --- page_patch: applied to the local mirror, never under a finger (R-54) ---

/** Rows as they were before this message's patches: «Отменить» puts them back at once, offline too. */
type Before = { itemId: string; linkId: string; old: PageLink | null };
const before = new Map<string, Before[]>();
/** Week 11: the page's look before the assistant changed its view (`set_view`), for «Отменить» offline. */
const looks = new Map<string, SavedLook[]>();
const patching = new Set<string>();
let patchChain: Promise<void> = Promise.resolve();

function whenReleased(): Promise<void> {
  if (!useView.getState().touching) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useView.subscribe((s) => {
      if (!s.touching) {
        unsub();
        resolve();
      }
    });
  });
}

function queuePatch(answerId: string, patch: PagePatchOut): void {
  patching.add(answerId);
  patchChain = patchChain
    .then(() => applyPatch(patch, answerId))
    .catch(() => undefined)
    .finally(() => patching.delete(answerId));
}

/**
 * Rows upserted by (page, item), `removed_item_ids` dropped, the version and group titles kept
 * (a sort clears the groups). `answerId`: keep what the rows were, for «Отменить» offline.
 */
async function applyPatch(patch: PagePatchOut, answerId?: string): Promise<void> {
  await whenReleased();
  const repo = await getPagesRepo();
  const now = new Map((await repo.linksFor(patch.page_id)).map((l) => [l.itemServerId, l]));
  const saved = answerId ? (before.get(answerId) ?? []) : [];
  const seen = new Set(saved.map((b) => b.itemId));
  const keep = (itemId: string, linkId: string) => {
    if (!answerId || seen.has(itemId)) return;
    saved.push({ itemId, linkId, old: now.get(itemId) ?? null });
    seen.add(itemId);
  };
  for (const link of patch.rows) {
    keep(link.item_id, link.id);
    await repo.applyLink(link);
  }
  for (const itemId of patch.removed_item_ids) {
    const old = now.get(itemId);
    if (!old) continue;
    keep(itemId, old.id);
    await repo.removeLink(old.id);
  }
  if (answerId) before.set(answerId, saved);
  const groups = patch.view_state ? (titlesToGroups(patch.view_state.groups ?? null) ?? []) : null;
  await repo.setView(patch.page_id, patch.view_version, groups);
  // Week 11: the assistant changed the view («покажи таблицей», «сгруппируй по магазинам»).
  const was = answerId && !(looks.get(answerId) ?? []).some((l) => l.pageServerId === patch.page_id) ? await lookBefore(patch.page_id) : null;
  if ((await applyAssistantView(patch)) && answerId && was) looks.set(answerId, [...(looks.get(answerId) ?? []), was]);
  notifyDataChanged();
  const action = answerId ? find(answerId)?.action : undefined;
  useView.getState().showHighlight(action ? action.changedItemIds : patch.rows.map((l) => l.item_id));
}

/** Resolves when the patches received so far are on the page. */
export function patchesApplied(): Promise<void> {
  return patchChain;
}

/** Puts the rows back as they were before the message's patch (all, or only `itemIds`). */
async function restoreBefore(answerId: string, itemIds: string[] | null): Promise<string[]> {
  await patchChain;
  const saved = before.get(answerId);
  if (!saved) return [];
  const repo = await getPagesRepo();
  if (!itemIds) {
    for (const l of looks.get(answerId) ?? []) await restoreLook(l);
    looks.delete(answerId);
  }
  const take = saved.filter((b) => !itemIds || itemIds.includes(b.itemId));
  for (const b of take) {
    if (b.old) await repo.restoreLinks([b.old]);
    else await repo.removeLink(b.linkId);
  }
  before.set(
    answerId,
    saved.filter((b) => !take.includes(b)),
  );
  notifyDataChanged();
  return take.map((b) => b.itemId);
}

const running = new Set<string>();

/** Streams one turn into the assistant message `answerId`. Never throws. */
async function runTurn(answerId: string): Promise<void> {
  if (running.has(answerId)) return;
  const first = find(answerId);
  const question = first && find(first.replyTo ?? '');
  if (!first || !question) return;
  running.add(answerId);
  store().updateMessage(answerId, { status: 'streaming', notice: null, activity: null });
  const onEvent = (e: ChatEvent) => apply(answerId, e);
  const finish = (status: ChatStatus, patch: Partial<ChatMessage> = {}) =>
    store().updateMessage(answerId, { status, activity: null, ...patch });
  try {
    for (let attempt = 0; ; attempt++) {
      const answer = find(answerId);
      if (!answer) return;
      try {
        if (answer.serverId) {
          await getApi().resumeChat(answer.serverId, answer.lastEventId ?? null, onEvent);
        } else {
          // The same client_id replays the first reply from its start: start the text over.
          store().updateMessage(answerId, { text: '', sources: [], lastEventId: null });
          await getApi().chat(body(question, answer), onEvent);
        }
        break;
      } catch (e) {
        const midway = e instanceof StreamDroppedError || (e instanceof NetworkError && attempt > 0);
        if (midway) {
          const delay = chatTiming.resumeBackoffMs[attempt];
          if (delay === undefined) {
            // A change may still finish on the server after the drop: do not offer to ask again.
            finish('interrupted', isChange(find(answerId)) || question.ask?.guess === 'action' ? { notice: 'maybe_done' } : {});
            break;
          }
          await sleep(delay);
          continue;
        }
        if (e instanceof NetworkError || e instanceof SignInRequiredError) {
          // Never reached the server: what the phone can do alone (3-engineering 5.10 «Без интернета»).
          const guess = question.ask?.guess ?? 'question';
          const list = listForPage(usePages.getState().pages.find((p) => p.id === question.pageId));
          if (looksLikeReminder(question.text) && !question.ask?.choice) {
            // Week 9: a reminder phrase is read when there is a connection → «Проверьте напоминание».
            keepPhrase(question.text);
            finish('failed', { notice: 'offline_reminder' });
          } else if (guess === 'note' && list) {
            // «Покупки» / «Дела» offline: a row of this list, as typed (with «Отменить» on the strip).
            await addTask({ list, title: question.text });
            finish('done', { saved: true, text: i18n.t('line.saved') });
          } else if (guess === 'note') await saveInstead(answerId, question);
          else if (guess === 'action') finish('failed', { notice: 'offline_action' });
          else finish('queued', { localHits: await localHits(question.text) });
        } else if (e instanceof ApiError && e.code === 'consent_required') {
          const missing = Array.isArray(e.details?.missing) ? (e.details.missing as unknown[]) : [];
          // No consent for the AI services → like «Без ИИ». Base consents still on their way → ask later.
          if (missing.includes('ai_cross_border')) finish('failed', { notice: 'no_ai' });
          else finish('queued', { localHits: await localHits(question.text) });
        } else if (e instanceof ApiError && e.status === 404 && answer.serverId) {
          // The reply is gone (history cleared): a new turn.
          finish('interrupted', { newTurn: true, serverId: null });
        } else if (e instanceof ApiError) {
          finish('failed', { notice: e.status === 429 ? 'limit' : 'error' });
        } else {
          finish('failed', { notice: 'error' });
        }
        break;
      }
    }
    const done = find(answerId);
    if (done && (done.status === 'done' || done.status === 'deferred') && store().banner?.messageId === answerId) {
      markDelivery(done, 'banner_shown');
    }
  } finally {
    running.delete(answerId);
  }
}

function replaceBanner(messageId: string): void {
  // A new request replaces the banner: the old one counts as closed.
  const old = store().banner;
  if (old && old.messageId !== messageId) markDelivery(find(old.messageId), 'dismissed');
  store().showBanner({ messageId });
  // An earlier choice or «Да» can't be answered any more once something new was asked.
  useView.getState().setPicking(null);
}

/**
 * A phrase for the assistant from the line. A text answer shows in the banner and in «Переписка»;
 * an action shows on the page. `o.context`: overrides of the page context (a tap on «Какую?»).
 */
export async function ask(
  text: string,
  page: AskPage,
  o: { guess?: LineGuess; context?: Partial<ChatAskContext> } = {},
): Promise<string> {
  const now = Date.now();
  const guess = o.guess ?? 'question';
  const question: ChatMessage = {
    id: newId(),
    role: 'user',
    text,
    pageId: page.id,
    pageTitle: page.title,
    at: new Date(now).toISOString(),
    ask: { ...pageContext(page.id), ...o.context, guess },
  };
  const answer: ChatMessage = {
    id: newId(),
    role: 'assistant',
    text: '',
    pageId: page.id,
    pageTitle: page.title,
    at: new Date(now + 1).toISOString(),
    replyTo: question.id,
    turnId: question.id,
    status: chatAllowed() ? 'streaming' : 'queued',
    sources: [],
  };
  store().addMessage(question);
  store().addMessage(answer);
  replaceBanner(answer.id);
  // «Нашёл у себя» first, then what the server finds (docs/api/chat.md «Notes for the phone»).
  if (guess === 'question') store().updateMessage(answer.id, { localHits: await localHits(text) });
  if (chatAllowed()) await runTurn(answer.id);
  return answer.id;
}

/** The phrase is saved as a record on its page, the way the line did it before week 6. */
async function saveNote(text: string, pageId: string): Promise<void> {
  const capture = await getCapture();
  await capture.saveText({ text, source: 'typed', pageId });
}

/** Never reached the server, and the phrase looked like a note: it is saved here instead. */
async function saveInstead(answerId: string, question: ChatMessage): Promise<void> {
  await saveNote(question.text, question.pageId);
  store().updateMessage(answerId, {
    status: 'done',
    activity: null,
    saved: true,
    text: i18n.t('line.saved'),
    localHits: [],
  });
}

function addLocalTurn(text: string, page: AskPage, reply: Partial<ChatMessage>): string {
  const now = Date.now();
  const question: ChatMessage = { id: newId(), role: 'user', text, pageId: page.id, pageTitle: page.title, at: new Date(now).toISOString() };
  const answer: ChatMessage = {
    id: newId(),
    role: 'assistant',
    text: '',
    pageId: page.id,
    pageTitle: page.title,
    at: new Date(now + 1).toISOString(),
    replyTo: question.id,
    status: 'done',
    ...reply,
  };
  store().addMessage(question);
  store().addMessage(answer);
  replaceBanner(answer.id);
  return answer.id;
}

/**
 * S13 «Понял так» from a reading of the server (chat `reminder_draft` or `/reminders/parse`).
 * Nothing is saved until [Сохранить]; `messageId` links the saved reminder to the line's answer.
 */
function openDraft(out: ReminderParseOut, messageId: string | null, text?: string, via?: 'voice' | 'typed'): void {
  const params: Record<string, string> = {};
  if (via === 'voice') params.via = via;
  if (text) params.text = text;
  const draft = out.draft ?? out.options[0] ?? null;
  if (draft) params.draft = JSON.stringify(draft);
  if (out.options.length > 1) params.options = JSON.stringify(out.options);
  if (out.message) params.message = out.message;
  if (messageId) params.messageId = messageId;
  router.push({ pathname: '/reminder-new', params });
}

/** What the line did with a phrase: the caller opens search for `search`, and S04b after `saved`. */
export type LineResult = 'search' | 'saved' | 'asked' | 'notice' | 'reminder';

/**
 * A phrase that asks for a reminder (week 8; chat does not set reminders yet): the server reads it
 * (`POST /reminders/parse` — its Ф-1 setting decides whether code or the model reads it, and in
 * «Без ИИ» it answers «Укажите время вручную»), then S13 «как понял»: nothing is set without
 * [Сохранить]. Without the internet the phone has no parser (Ф-1 not taken): «Поставлю, когда
 * появится интернет» [Поставить вручную]; the phrase is parsed once there is a connection and
 * comes back as «Проверьте напоминание».
 */
async function reminderFromLine(text: string, page: AskPage): Promise<LineResult> {
  const o = useOnboarding.getState();
  if (o.consent !== null && !syncBlocked()) {
    try {
      openDraft(await parsePhrase(text), null, text);
      return 'reminder';
    } catch (e) {
      if (!(e instanceof NetworkError) && !(e instanceof SignInRequiredError)) {
        router.push({ pathname: '/reminder-new', params: { text } });
        return 'reminder';
      }
    }
  }
  keepPhrase(text);
  addLocalTurn(text, page, { status: 'failed', notice: 'offline_reminder' });
  return 'notice';
}

/**
 * Everything typed in the line comes here (R-53). Online with consent the server decides what it
 * is; without it the phone's guess: a question is a search by words («Без ИИ») or waits for the
 * connection, a note is saved on this page, a change says it needs the assistant (2-design 6.9).
 */
export async function sendFromLine(text: string, page: AskPage): Promise<LineResult> {
  // Week 9 (reminders.md, chat.md): online the server reads reminder phrases in the one
  // conversation (`reminder_draft`); `/reminders/parse` only without it («Без ИИ», offline).
  const askable = chatAllowed() && lineRouting.serverDecides;
  if (looksLikeReminder(text) && !askable) return reminderFromLine(text, page);
  const guess = guessLine(text);
  const o = useOnboarding.getState();
  const noAi = o.consent !== null && selectNoAi(o);
  const local = (notice: ChatNotice) => {
    addLocalTurn(text, page, { status: 'failed', notice });
    return 'notice' as const;
  };
  if (noAi) {
    if (guess === 'question') return 'search';
    if (guess === 'action') return local('no_ai_action');
  }
  // «Покупки» / «Дела» without the assistant (offline, «Без ИИ», before consent): the phrase is a
  // row of this list, as typed (no splitting: that is the assistant's reading, or Ф-1 code).
  const list = listForPage(usePages.getState().pages.find((p) => p.id === page.id));
  if (list && guess === 'note' && (noAi || !askable)) {
    // The strip «Добавил в Покупки: … [Отменить]» is the result (no banner: R-52 п. 2).
    await addTask({ list, title: text });
    return 'saved';
  }
  if (guess === 'note' && (noAi || !lineRouting.serverDecides || !chatAllowed())) {
    await saveNote(text, page.id);
    addLocalTurn(text, page, { status: 'done', saved: true, text: i18n.t('line.saved') });
    return 'saved';
  }
  if (guess === 'action' && !chatAllowed()) return local('offline_action');
  void ask(text, page, { guess });
  return 'asked';
}

/** «Спросить ещё раз»: resumes the same reply, or a new turn when the server asked for one. */
export async function retry(answerId: string): Promise<void> {
  const m = find(answerId);
  if (!m) return;
  if (m.newTurn) store().updateMessage(answerId, { turnId: newId(), serverId: null, lastEventId: null, newTurn: false });
  if (!chatAllowed()) {
    store().updateMessage(answerId, { status: 'queued' });
    return;
  }
  await runTurn(answerId);
}

let flushing = false;

/** Questions asked without a connection go when there is one (foreground, timer, a request got through). */
export async function flushQueued(): Promise<void> {
  if (flushing) return;
  const queued = store().messages.filter((m) => m.role === 'assistant' && m.status === 'queued');
  if (queued.length === 0) return;
  const o = useOnboarding.getState();
  if (o.consent !== null && selectNoAi(o)) {
    // «Без ИИ» chosen after asking: nothing goes out.
    for (const m of queued) store().updateMessage(m.id, { status: 'failed', notice: 'no_ai' });
    return;
  }
  if (!chatAllowed()) return;
  flushing = true;
  try {
    for (const m of queued) {
      await runTurn(m.id);
      if (find(m.id)?.status === 'queued') break; // still offline
    }
  } finally {
    flushing = false;
  }
}

// --- the result of an action: «Отменить», «Вернуть» one line, «Какую?», «Да» ---

const pageOf = (m: ChatMessage): AskPage => {
  const p = usePages.getState().pages.find((x) => x.id === m.pageId);
  return { id: m.pageId, title: m.pageTitle, serverId: p?.serverId ?? null };
};

/**
 * «Отменить» / «Вернуть» (R-31, actions.md): the server runs the undo and sends the rows as they
 * are now (`page_patches`). Without a connection the page goes back at once from the rows the phone
 * kept, and the undo waits in the outbox with the same `client_id` (a repeat returns the first result).
 */
async function runUndo(messageId: string, a: ChatAction, itemIds: string[] | null, keys?: string[]): Promise<void> {
  const clientId = newId();
  const t = i18n.t.bind(i18n);
  try {
    const out = await getApi().undoAction(a.id, {
      client_id: clientId,
      ...(itemIds ? { item_ids: itemIds } : {}),
      ...(keys ? { keys } : {}),
    });
    for (const patch of out.page_patches) await applyPatch(patch);
    if (out.action) {
      const now = fromAction(out.action);
      store().updateMessage(messageId, (m) => ({
        action: { ...now, changedItemIds: m.action?.changedItemIds ?? now.changedItemIds, undone: !itemIds || !now.undoable || now.undone },
      }));
    }
    if (out.partial && out.message_ru) useToast.getState().show(out.message_ru);
    kickSync();
  } catch (e) {
    if (e instanceof NetworkError || e instanceof SignInRequiredError) {
      if (!keys) await restoreBefore(messageId, itemIds);
      const payload: ActionUndoPayload = { actionId: a.id, clientId, ...(itemIds ? { itemIds } : {}), ...(keys ? { settingKeys: keys } : {}) };
      await (await getOutbox()).enqueue('action.undo', payload);
      return;
    }
    // 410 undo_expired: older than 30 days, or nothing left to undo.
    if (e instanceof ApiError && e.status === 410) {
      store().updateMessage(messageId, (m) => (m.action ? { action: { ...m.action, undoable: false } } : {}));
      useToast.getState().show(t('changes.expired'));
      return;
    }
    store().updateMessage(messageId, (m) => (m.action ? { action: { ...m.action, undone: false } } : {}));
    useToast.getState().show(t('errors.generic'));
  }
}

/** «Отменить» the whole action of this answer. */
export async function undoAction(messageId: string): Promise<void> {
  const a = find(messageId)?.action;
  if (!a || a.undone || !a.undoable || useOnboarding.getState().consent === null) return;
  store().updateMessage(messageId, { action: { ...a, undone: true } });
  await runUndo(messageId, a, null);
}

/** «Что изменилось → Вернуть» on one row: only that record goes back. */
export async function revertChange(messageId: string, itemId: string): Promise<void> {
  const a = find(messageId)?.action;
  if (!a || a.undone || !a.undoable || useOnboarding.getState().consent === null) return;
  const changes = a.changes.map((c) => (c.itemId === itemId ? { ...c, reverted: true } : c));
  store().updateMessage(messageId, { action: { ...a, changes, undone: changes.every((c) => c.reverted) } });
  useView.getState().showHighlight([itemId]);
  await runUndo(messageId, a, [itemId]);
}

/** «Что изменилось → Вернуть» on a view setting («Вид: Список → Таблица»): `keys` (views.md). */
export async function revertSetting(messageId: string, key: string): Promise<void> {
  const a = find(messageId)?.action;
  if (!a || a.undone || !a.undoable || useOnboarding.getState().consent === null) return;
  const changes = a.changes.map((c) => (c.key === key ? { ...c, reverted: true } : c));
  store().updateMessage(messageId, { action: { ...a, changes, undone: changes.every((c) => c.reverted) } });
  // Without `itemIds` the record rows stay; with `[]` nothing local is put back (the look comes back from the server).
  await runUndo(messageId, a, [], [key]);
}

/** The phrase the assistant asked about. */
const askedText = (m: ChatMessage): string => find(m.replyTo ?? '')?.text ?? '';

/**
 * A tap on a question back (docs/api/chat.md Proposal): `pick` lets the person tap the record on
 * the page; every other option goes as `choice` with its label as the text, «Нет» / «Отмена» too
 * (the server answers «Хорошо, ничего не менял.»). «Оставить мои»: nothing placed by hand moves.
 */
export async function answerProposal(messageId: string, optionId: string): Promise<void> {
  const m = find(messageId);
  const p = m?.proposal;
  const option = p?.options.find((o) => o.id === optionId);
  if (!m || !p || !option || p.answered) return;
  store().updateMessage(messageId, { proposal: { ...p, answered: option.id } });
  if (option.kind === 'pick') {
    useView.getState().setPicking({ messageId, pageId: m.pageId });
    return;
  }
  if (!m.serverId) return;
  await ask(option.label, pageOf(m), {
    guess: 'action',
    context: { choice: { replyId: m.serverId, option: option.id } },
  });
}

/** «Выбрать»: the record tapped is «это» — the original phrase again, with it selected. */
export async function pickRecord(itemServerId: string): Promise<void> {
  const picking = useView.getState().picking;
  const m = picking ? find(picking.messageId) : undefined;
  useView.getState().setPicking(null);
  if (!m) return;
  await ask(askedText(m), pageOf(m), { guess: 'action', context: { selectedItemId: itemServerId } });
}

/** «Выбрать» stopped without a tap. */
export function cancelPick(): void {
  useView.getState().setPicking(null);
  store().closeBanner();
}

// --- the answer that waits on «Сегодня» (6.11 п. 3–4) ---

function localPage(ref: { id: string; title: string } | null): { id: string; title: string } {
  const page = ref ? usePages.getState().pages.find((p) => p.serverId === ref.id) : undefined;
  if (page) return { id: page.id, title: page.title ?? i18n.t(`tpl.${page.templateKey}`) };
  return { id: 'today', title: ref?.title || i18n.t('tpl.today') };
}

const STATE: Record<ChatMessageOut['state'], ChatStatus> = {
  done: 'done',
  deferred: 'deferred',
  failed: 'failed',
  // Still being written: «Спросить ещё раз» resumes it.
  pending: 'interrupted',
};

/** Server history → local messages. An answer is paired with the phone's one by its question. */
export function fromHistory(list: ChatMessageOut[], local: readonly ChatMessage[]): ChatMessage[] {
  const userLocalId = new Map<string, string>();
  for (const m of list) if (m.role === 'user') userLocalId.set(m.id, m.client_id ?? `srv-${m.id}`);
  return list.map((m): ChatMessage => {
    const page = localPage(m.page);
    if (m.role === 'user') {
      const id = userLocalId.get(m.id) as string;
      const mine = local.find((x) => x.id === id);
      return {
        id,
        role: 'user',
        text: m.text,
        pageId: mine?.pageId ?? page.id,
        pageTitle: mine?.pageTitle ?? page.title,
        at: mine?.at ?? m.created_at,
        serverId: m.id,
      };
    }
    const question = m.reply_to ? (userLocalId.get(m.reply_to) ?? local.find((x) => x.serverId === m.reply_to)?.id) : undefined;
    const pair = local.find((x) => x.role === 'assistant' && (x.serverId === m.id || (question && x.replyTo === question)));
    return {
      id: pair?.id ?? `srv-${m.id}`,
      role: 'assistant',
      text: m.text,
      pageId: pair?.pageId ?? page.id,
      pageTitle: pair?.pageTitle ?? page.title,
      at: pair?.at ?? m.created_at,
      serverId: m.id,
      replyTo: question ?? pair?.replyTo,
      turnId: pair?.turnId ?? question,
      status: STATE[m.state],
      // A change cut off midway may be finished in the background: not «не сделано».
      notice:
        m.state === 'failed'
          ? m.answer_kind === 'action' || m.error_code === 'stream_interrupted'
            ? 'maybe_done'
            : 'error'
          : (m.state === 'pending' || m.state === 'deferred') && m.answer_kind === 'action'
            ? 'maybe_done'
            : null,
      sources: m.citations.map(fromCitation),
      aiGenerated: m.ai_label !== null,
      answerKind: m.answer_kind,
      ...(m.action ? { action: fromAction(m.action) } : pair?.action ? { action: pair.action } : {}),
      ...(m.proposal ? { proposal: fromProposal(m.proposal) } : pair?.proposal ? { proposal: pair.proposal } : {}),
    };
  });
}

/** «Переписка» opened: bring what the server has (answers finished after a drop, other phones). */
export async function loadHistory(): Promise<void> {
  if (!chatAllowed()) return;
  try {
    const out = await getApi().chatHistory();
    store().mergeMessages(fromHistory(out.messages, store().messages));
  } catch {
    // offline: the phone's own history is on screen
  }
}

/**
 * GET /chat/pending-banner: an answer the server finished while the phone was away (job
 * `chat:complete`) waits on «Сегодня» as «Ответ готов: …». Called when «Сегодня» opens, on return to
 * the foreground, and when the push «Ответ готов» comes. Returns the local id of that answer.
 */
export async function refreshPending(): Promise<string | null> {
  if (!chatAllowed()) return null;
  let out: ChatMessageOut | null;
  try {
    out = (await getApi().pendingBanner()).message;
  } catch {
    return store().pending?.messageId ?? null;
  }
  if (!out) {
    store().setPending(null);
    return null;
  }
  const serverMsg = out;
  store().mergeMessages(fromHistory([serverMsg], store().messages));
  const local = store().messages.find((m) => m.serverId === serverMsg.id);
  if (!local) return null;
  // The banner over the line already shows it: one place is enough.
  if (store().banner?.messageId === local.id) return local.id;
  if (store().pending?.messageId !== local.id) {
    store().setPending({ messageId: local.id });
    markDelivery(local, 'banner_shown');
  }
  return local.id;
}

/** «Открыть ответ» on the «Сегодня» card or a tapped push: the local id to open «Переписка» on. */
export function openPending(): string | null {
  const id = store().pending?.messageId ?? null;
  if (id) markDelivery(find(id), 'opened');
  store().setPending(null);
  return id;
}

export function closePending(): void {
  const id = store().pending?.messageId;
  if (id) markDelivery(find(id), 'dismissed');
  store().setPending(null);
}

/**
 * A push «Ответ готов» tapped (or the app started from it): the answer comes from the server and
 * «Переписка» opens on it. Returns the local id, or null when the push was not ours / is stale.
 */
export async function answerFromPush(data: unknown): Promise<string | null> {
  const push = answerReadyFrom(data);
  if (!push) return null;
  await refreshPending();
  let local = push.reply_id ? store().messages.find((m) => m.serverId === push.reply_id) : undefined;
  if (!local && push.reply_id && chatAllowed()) {
    try {
      const out = await getApi().chatMessage(push.reply_id);
      if (out) store().mergeMessages(fromHistory([out], store().messages));
      local = store().messages.find((m) => m.serverId === push.reply_id);
    } catch {
      // offline: open «Переписка» with what the phone has
    }
  }
  const id = local?.id ?? store().pending?.messageId ?? null;
  if (id && store().pending?.messageId === id) openPending();
  else if (local) markDelivery(local, 'opened');
  return id;
}

/** Best effort: what the phone showed (docs/api/chat.md «Delivery»). */
export function markDelivery(m: ChatMessage | undefined, state: ChatDeliveryState): void {
  if (!m?.serverId || m.role !== 'assistant' || m.saved || !chatAllowed()) return;
  void getApi()
    .chatDelivery(m.serverId, state)
    .catch(() => undefined);
}

/** A source chip pressed: the record (brought to the phone if not here yet) and its page. */
export async function resolveSource(s: ChatSource): Promise<{ recordId: string; pageId: string | null } | null> {
  const records = await getRecords();
  let rec = await records.findByServerId(s.itemId);
  if (!rec) {
    try {
      rec = await fetchRecord(s.itemId);
    } catch {
      return null;
    }
  }
  if (!rec) return null;
  const page = s.pageServerId ? usePages.getState().pages.find((p) => p.serverId === s.pageServerId) : undefined;
  return { recordId: rec.id, pageId: page?.id ?? null };
}

/** «Сообщить о проблеме» is offered only on an answer the server has (its id is the target). */
export const canReport = (m: ChatMessage): boolean => m.role === 'assistant' && !m.saved && !!m.serverId;

/**
 * «Сообщить о проблеме» (R-41): queued in the outbox, so it goes also after being offline. Stays in
 * KZ; an anonymised example only with the tick, unchecked by default (R-23).
 */
export async function reportProblem(
  m: ChatMessage,
  f: { reason: FeedbackReason; comment: string; allowExample: boolean },
): Promise<void> {
  if (!m.serverId) return;
  const feedback: FeedbackIn = {
    client_id: newId(),
    target: 'answer',
    target_ref: m.serverId,
    reason: f.reason,
    comment: f.comment.trim().slice(0, 1000) || null,
    allow_anonymized_example: f.allowExample,
  };
  await (await getOutbox()).enqueue('feedback.send', feedback);
  kickSync();
}
