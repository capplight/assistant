import { ApiError, NetworkError, SignInRequiredError } from '@/api/errors';
import { StreamDroppedError } from '@/api/sse';
import type {
  ChatCitationOut,
  ChatDeliveryState,
  ChatEvent,
  ChatMessageIn,
  ChatMessageOut,
  ChatSourceOut,
  FeedbackIn,
  FeedbackReason,
} from '@/api/types';
import { getOutbox, getRecords, isTrashed } from '@/db';
import i18n from '@/i18n';
import { searchRecords } from '@/records/search';
import { LIST_LIMIT } from '@/records/useRecords';
import { fetchRecord, getApi, kickSync, syncBlocked } from '@/services';
import { useAssistant, type ChatMessage, type ChatSource, type ChatStatus } from '@/store/assistant';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { newId } from '@/utils/id';

/**
 * The single conversation (R-52, docs/api/chat.md): a question from the line on any page goes to
 * POST /chat/messages and streams into one assistant message; the banner and «Переписка» both show
 * that message. Week 5 is questions only: notes are still saved on the phone (offline-first), and
 * actions («Разложи», create, move) come with the mutating tools in week 6.
 *
 * A dropped stream: resume with `Last-Event-ID` (GET …/events) at 1, 2, 4, 10 s; before `accepted`
 * the same POST again (same client_id = the same turn). Still nothing → «Связь прервалась» with
 * «Спросить ещё раз». No connection at all → queued, asked when the connection is back.
 */

export type AskPage = { id: string; title: string; serverId: string | null };

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

/** Records on the phone that match the question by words («Нашёл у себя»). */
async function localHits(text: string): Promise<string[]> {
  try {
    const all = (await (await getRecords()).list(LIST_LIMIT)).filter((r) => !isTrashed(r) && !r.hiddenReason);
    return searchRecords(all, text, LOCAL_HITS).map((r) => r.id);
  } catch {
    return [];
  }
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
      });
      return;
    }
    case 'done':
      updateMessage(answerId, (m) => ({
        status: 'done',
        activity: null,
        serverId: e.replyId ?? m.serverId ?? null,
        notice: e.limited ? 'limit' : m.notice,
      }));
      return;
    case 'deferred':
      updateMessage(answerId, (m) => ({ status: 'deferred', activity: null, serverId: e.replyId ?? m.serverId ?? null }));
      return;
    case 'error':
      updateMessage(answerId, (m) =>
        e.code === 'consent_required'
          ? { status: 'failed', activity: null, notice: 'no_ai' }
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
  return {
    client_id: answer.turnId ?? question.id,
    text: question.text,
    page_id: page?.serverId ?? null,
    lang: useOnboarding.getState().language,
    input_kind: 'typed',
  };
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
            finish('interrupted');
            break;
          }
          await sleep(delay);
          continue;
        }
        if (e instanceof NetworkError || e instanceof SignInRequiredError) {
          finish('queued', { localHits: await localHits(question.text) });
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

/** A question from the assistant line. The answer shows in the banner and in «Переписка». */
export async function ask(text: string, page: AskPage): Promise<string> {
  const now = Date.now();
  const question: ChatMessage = {
    id: newId(),
    role: 'user',
    text,
    pageId: page.id,
    pageTitle: page.title,
    at: new Date(now).toISOString(),
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
  // A new request replaces the banner: the old one counts as closed.
  const old = store().banner;
  if (old) markDelivery(find(old.messageId), 'dismissed');
  store().addMessage(question);
  store().addMessage(answer);
  store().showBanner({ messageId: answer.id });
  // «Нашёл у себя» first, then what the server finds (docs/api/chat.md «Notes for the phone»).
  store().updateMessage(answer.id, { localHits: await localHits(text) });
  if (chatAllowed()) await runTurn(answer.id);
  return answer.id;
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
    const question = m.reply_to ? userLocalId.get(m.reply_to) : undefined;
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
      notice: m.state === 'failed' ? 'error' : null,
      sources: m.citations.map(fromCitation),
      aiGenerated: m.ai_label !== null,
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
