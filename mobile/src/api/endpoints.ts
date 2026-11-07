import type { ApiClient } from './client';
import { ApiError } from './errors';
import { readSse, StreamDroppedError, type SseMessage } from './sse';
import type {
  ActionChangeOut,
  ActionOut,
  ActionUndoIn,
  ActionUndoOut,
  AnswerReadyPushData,
  PageItemOut,
  PagePatchOut,
  PendingBannerOut,
  ProposalOut,
  ChatDeliveryState,
  ChatEvent,
  ChatHistoryOut,
  ChatMessageIn,
  ChatMessageOut,
  ChatCitationOut,
  ChatPageRef,
  ChatSourceOut,
  FeedbackIn,
  FeedbackOut,
  ConsentsIn,
  ConsentsOut,
  ConsentTextOut,
  DeviceIn,
  DeviceOut,
  ItemCreateIn,
  ItemCreateOut,
  ItemOut,
  ItemPatchIn,
  Locale,
  OtpRequestIn,
  OtpRequestOut,
  OtpVerifyIn,
  OtpVerifyOut,
  PageCreateIn,
  PageCreateOut,
  PageLinkCreateOut,
  PageOut,
  PagePatchIn,
  ProfilePatchIn,
  SearchIn,
  SearchOut,
  ServerConsentKind,
  SyncOut,
  UploadIn,
  UploadOut,
  UserOut,
} from './types';

/** Reads a local file and PUTs it to a presigned URL. Injected so tests don't touch the filesystem. */
export type PutFile = (fileUri: string, put: NonNullable<UploadOut['put']>) => Promise<void>;

/** No bytes for this long while an answer streams → dropped (the server sends keep-alives every ~15 s). */
export const CHAT_IDLE_MS = 40_000;

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function pageRef(v: unknown): ChatPageRef | null {
  const o = obj(v);
  const id = o && str(o.id);
  return o && id ? { id, title: str(o.title) ?? '', icon: str(o.icon) } : null;
}

function sourceOut(v: unknown): ChatSourceOut | null {
  const o = obj(v);
  const itemId = o && str(o.item_id);
  if (!o || !itemId) return null;
  return {
    ref: str(o.ref) ?? itemId,
    item_id: itemId,
    title: str(o.title),
    snippet: str(o.snippet),
    kind: str(o.kind),
    occurred_at: str(o.occurred_at),
    created_at: str(o.created_at),
    page: pageRef(o.page),
    pages: arr(o.pages).map(pageRef).filter((x): x is ChatPageRef => x !== null),
  };
}

function citationOut(v: unknown): ChatCitationOut | null {
  const o = obj(v);
  const itemId = o && str(o.item_id);
  if (!o || !itemId) return null;
  return {
    ref: str(o.ref) ?? itemId,
    item_id: itemId,
    chunk_id: str(o.chunk_id),
    page: pageRef(o.page),
    title: str(o.title),
    label: str(o.label),
    occurred_at: str(o.occurred_at),
  };
}

const citations = (v: unknown) => arr(v).map(citationOut).filter((x): x is ChatCitationOut => x !== null);

/** ChatMessage of docs/api/chat.md → ChatMessageOut; null when it is not one. */
export function chatMessageOut(v: unknown): ChatMessageOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const role = o && (o.role === 'user' || o.role === 'assistant') ? o.role : null;
  if (!o || !id || !role) return null;
  const state = o.state === 'pending' || o.state === 'deferred' || o.state === 'failed' ? o.state : 'done';
  const checked = obj(o.checked);
  return {
    id,
    client_id: str(o.client_id),
    role,
    reply_to: str(o.reply_to),
    page: pageRef(o.page),
    input_kind: (str(o.input_kind) as ChatMessageOut['input_kind']) ?? null,
    text: str(o.text) ?? '',
    answer_kind: (str(o.answer_kind) as ChatMessageOut['answer_kind']) ?? null,
    state,
    citations: citations(o.citations),
    checked: checked ? { ok: checked.ok !== false, removed: Number(checked.removed) || 0 } : null,
    delivery: (str(o.delivery) as ChatMessageOut['delivery']) ?? null,
    ai_label: str(o.ai_label),
    action: actionOut(o.action),
    proposal: proposalOut(o.proposal),
    choice: choiceIn(o.choice),
    error_code: str(o.error_code),
    created_at: str(o.created_at) ?? new Date().toISOString(),
  };
}

// --- week 6: Action (actions.md), PagePatch and Proposal (chat.md) ---

const strs = (v: unknown): string[] => arr(v).map(str).filter((x): x is string => x !== null);

function changeOut(v: unknown): ActionChangeOut | null {
  const o = obj(v);
  const itemId = o && str(o.item_id);
  if (!o || !itemId) return null;
  return {
    item_id: itemId,
    title: str(o.title),
    kind: str(o.kind),
    text: str(o.text) ?? str(o.title) ?? '',
    page_id: str(o.page_id),
    reverted: o.reverted === true,
  };
}

export function actionOut(v: unknown): ActionOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const summary = o && obj(o.summary);
  const ru = summary ? str(summary.ru) : o ? str(o.summary) : null;
  if (!o || !id || !ru) return null;
  return {
    id,
    kind: str(o.kind) ?? 'action',
    summary: { ru, kk: summary ? str(summary.kk) : null },
    page: pageRef(o.page),
    changes: arr(o.changes).map(changeOut).filter((x): x is ActionChangeOut => x !== null),
    changed_item_ids: strs(o.changed_item_ids),
    created_page_id: str(o.created_page_id),
    undoable: o.undoable === true,
    undoable_until: str(o.undoable_until),
    undone_at: str(o.undone_at),
    undo_of: str(o.undo_of),
    message_id: str(o.message_id),
  };
}

function linkOut(v: unknown): PageItemOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const pageId = o && str(o.page_id);
  const itemId = o && str(o.item_id);
  if (!o || !id || !pageId || !itemId) return null;
  return {
    id,
    page_id: pageId,
    item_id: itemId,
    position: str(o.position),
    group_key: str(o.group_key),
    manual_order: o.manual_order === true,
    manual_at: str(o.manual_at),
    pinned: o.pinned === true,
    added_by: str(o.added_by) ?? 'agent',
    removed_at: str(o.removed_at),
    seq: Number(o.seq) || 0,
    updated_at: str(o.updated_at) ?? new Date().toISOString(),
    updated_by: str(o.updated_by) ?? 'agent',
  };
}

/** `view_state.groups`: group titles in order; null when the view has none. */
export function groupTitles(viewState: unknown): string[] | null {
  const vs = obj(viewState);
  return vs && Array.isArray(vs.groups) ? strs(vs.groups) : null;
}

export function pagePatchOut(v: unknown): PagePatchOut | null {
  const d = obj(v);
  const pageId = d && str(d.page_id);
  if (!d || !pageId) return null;
  const vs = obj(d.view_state);
  const groups = groupTitles(vs);
  return {
    page_id: pageId,
    view_version: Number(d.view_version) || 0,
    view_state: vs ? { ...vs, ...(groups ? { groups } : {}) } : null,
    rows: arr(d.rows).map(linkOut).filter((x): x is PageItemOut => x !== null),
    removed_item_ids: strs(d.removed_item_ids),
  };
}

const OPTION_KINDS = new Set(['item', 'pick', 'yes', 'no', 'keep_mine', 'cancel']);
type ProposalOption = ProposalOut['options'][number];

export function proposalOut(v: unknown): ProposalOut | null {
  const d = obj(v);
  const question = d && str(d.question);
  if (!d || !question) return null;
  const options = arr(d.options)
    .map((x, i): ProposalOption | null => {
      const o = obj(x);
      const label = o && str(o.label);
      if (!o || !label) return null;
      const kind = (OPTION_KINDS.has(String(o.kind)) ? o.kind : 'cancel') as ProposalOption['kind'];
      return { id: str(o.id) ?? String(i), label, kind, item_id: str(o.item_id) };
    })
    .filter((x): x is ProposalOption => x !== null);
  if (options.length === 0) return null;
  return {
    reply_id: str(d.reply_id),
    kind: d.kind === 'count' || d.kind === 'manual' ? d.kind : 'choice',
    question,
    count: typeof d.count === 'number' ? d.count : null,
    item_ids: strs(d.item_ids),
    options,
    default: str(d.default),
    expires_at: str(d.expires_at),
    state: d.state === 'answered' || d.state === 'expired' ? d.state : 'open',
  };
}

function choiceIn(v: unknown): { reply_id: string; option: string } | null {
  const c = obj(v);
  const replyId = c && str(c.reply_id);
  const option = c && str(c.option);
  return replyId && option ? { reply_id: replyId, option } : null;
}

/** One SSE message → a typed event (docs/api/chat.md «Events»). Unknown events: null (ignored). */
export function decodeChatEvent(m: SseMessage): ChatEvent | null {
  let d: Obj = {};
  try {
    d = obj(m.data ? JSON.parse(m.data) : {}) ?? {};
  } catch {
    return null;
  }
  const e = ((): ChatEvent | null => {
    switch (m.event) {
      case 'accepted':
        return { type: 'accepted', messageId: str(d.message_id), replyId: str(d.reply_id) };
      case 'status':
      case 'tool_activity': {
        const text = str(d.text);
        return text ? { type: 'status', text } : null;
      }
      case 'sources':
        return { type: 'sources', sources: arr(d.sources).map(sourceOut).filter((x): x is ChatSourceOut => x !== null) };
      case 'token': {
        const text = str(d.text);
        return text !== null ? { type: 'token', text } : null;
      }
      case 'citations':
        return { type: 'citations', citations: citations(d.citations) };
      case 'checked':
        return { type: 'checked', ok: d.ok !== false, removed: Number(d.removed) || 0 };
      case 'banner':
        return {
          type: 'banner',
          replyId: str(d.reply_id),
          text: str(d.text) ?? '',
          preview: str(d.preview) ?? '',
          short: d.short === true,
          aiLabel: str(d.ai_label),
          citations: citations(d.citations),
        };
      case 'done': {
        const kind = str(d.answer_kind);
        return {
          type: 'done',
          replyId: str(d.reply_id),
          limited: d.limited === true,
          answerKind: (kind as ChatMessageOut['answer_kind']) ?? null,
          actionId: str(d.action_id),
        };
      }
      case 'action': {
        const action = actionOut(d.action);
        if (!action) return null;
        const ids = strs(d.changed_item_ids);
        return { type: 'action', action, changedItemIds: ids.length > 0 ? ids : action.changed_item_ids };
      }
      case 'page_patch': {
        const patch = pagePatchOut(d);
        return patch ? { type: 'page_patch', patch } : null;
      }
      case 'needs_choice':
      case 'confirm':
      case 'confirm_manual': {
        const proposal = proposalOut(obj(d.proposal) ?? d);
        return proposal ? { type: 'proposal', proposal } : null;
      }
      case 'deferred':
        return { type: 'deferred', replyId: str(d.reply_id), text: str(d.text) };
      case 'error':
        return {
          type: 'error',
          replyId: str(d.reply_id),
          code: str(d.code) ?? 'internal',
          messageRu: str(d.message_ru) ?? '',
          messageKk: str(d.message_kk) ?? '',
          retry: d.retry === true,
        };
      case 'snapshot': {
        const message = chatMessageOut(d.message);
        return message ? { type: 'snapshot', message } : null;
      }
      default:
        return null;
    }
  })();
  return e ? { ...e, eventId: m.id } : null;
}

/** Typed /v1 endpoints. The ONLY place that knows paths and request bodies. */
export class Api {
  constructor(
    readonly client: ApiClient,
    private readonly putFile?: PutFile,
  ) {}

  // phone (S04b): link to this account, or sign into the account that already has this phone
  requestOtp(body: OtpRequestIn): Promise<OtpRequestOut> {
    return this.client.requestOptionalAuth('POST', '/auth/otp/request', { body });
  }

  /** Does not save the tokens: the caller first has to stop whatever works as the old account. */
  verifyOtp(body: OtpVerifyIn): Promise<OtpVerifyOut> {
    return this.client.requestOptionalAuth('POST', '/auth/otp/verify', { body });
  }

  patchProfile(body: ProfilePatchIn): Promise<UserOut> {
    return this.client.request('PATCH', '/me', { body });
  }

  // consents — the text endpoint is public (shown before any account data matters)
  getConsentText(kind: ServerConsentKind, locale: Locale): Promise<ConsentTextOut> {
    return this.client.request('GET', '/consents/text', { auth: false, query: { kind, locale } });
  }

  grantConsents(body: ConsentsIn): Promise<ConsentsOut> {
    return this.client.request('POST', '/consents', { body });
  }

  // devices — only after pd_processing + terms (server: 403 consent_required otherwise)
  upsertDevice(body: DeviceIn): Promise<DeviceOut> {
    return this.client.request('POST', '/devices', { body });
  }

  // uploads: create (idempotent by client_id) → PUT bytes → complete
  createUpload(body: UploadIn): Promise<UploadOut> {
    return this.client.request('POST', '/uploads', { body });
  }

  completeUpload(id: string): Promise<UploadOut> {
    return this.client.request('POST', `/uploads/${encodeURIComponent(id)}/complete`);
  }

  /**
   * Full upload of one local file. Safe to repeat after any failure: the same `clientId` returns
   * the same upload (fresh URL while pending; `put: null` once completed).
   */
  async uploadFile(f: { clientId: string; uri: string; mime: string; bytes: number; sha256: string }): Promise<string> {
    const up = await this.createUpload({ client_id: f.clientId, mime: f.mime, bytes: f.bytes, sha256: f.sha256 });
    if (up.state === 'completed' || !up.put) return up.id;
    if (!this.putFile) throw new Error('putFile not configured');
    await this.putFile(f.uri, up.put);
    const done = await this.completeUpload(up.id);
    if (done.state !== 'completed') throw new ApiError(409, { code: 'upload_mismatch' });
    return done.id;
  }

  // items / sync — spec §4.3/§4.4 (server still in progress), see types.ts
  createItem(body: ItemCreateIn): Promise<ItemCreateOut> {
    return this.client.request('POST', '/items', { body, idempotencyKey: body.client_id });
  }

  getItem(id: string): Promise<ItemOut> {
    return this.client.request('GET', `/items/${encodeURIComponent(id)}`);
  }

  patchItem(id: string, body: ItemPatchIn): Promise<ItemOut> {
    return this.client.request('PATCH', `/items/${encodeURIComponent(id)}`, { body });
  }

  /** «Отменить» for an automatically merged exact repeat: the record is visible again. */
  unmergeItem(id: string): Promise<ItemOut> {
    return this.client.request('POST', `/items/${encodeURIComponent(id)}/unmerge`);
  }

  /** To «Удалённые записи» for 30 days. Repeatable. */
  deleteItem(id: string): Promise<ItemOut> {
    return this.client.request('DELETE', `/items/${encodeURIComponent(id)}`);
  }

  restoreItem(id: string): Promise<ItemOut> {
    return this.client.request('POST', `/items/${encodeURIComponent(id)}/restore`);
  }

  // search — docs/api/search.md
  search(query: SearchIn): Promise<SearchOut> {
    return this.client.request('GET', '/search', { query });
  }

  // pages — docs/api/pages.md
  createPage(body: PageCreateIn): Promise<PageCreateOut> {
    return this.client.request('POST', '/pages', { body, idempotencyKey: body.client_id });
  }

  getPage(id: string): Promise<PageOut> {
    return this.client.request('GET', `/pages/${encodeURIComponent(id)}`);
  }

  patchPage(id: string, body: PagePatchIn): Promise<PageOut> {
    return this.client.request('PATCH', `/pages/${encodeURIComponent(id)}`, { body });
  }

  /** Show an existing item on this page too. Idempotent by page + item. */
  addItemToPage(pageId: string, itemId: string): Promise<PageLinkCreateOut> {
    return this.client.request('POST', `/pages/${encodeURIComponent(pageId)}/items`, { body: { item_id: itemId } });
  }

  sync(since: number, limit = 200): Promise<SyncOut> {
    return this.client.request('GET', '/sync', { query: { since, limit } });
  }

  // chat — docs/api/chat.md

  /** Reads one reply's stream; throws StreamDroppedError when it ends before `done`/`deferred`/`error`. */
  private async readReply(res: Response, onEvent: (e: ChatEvent) => void, o: { signal?: AbortSignal; idleMs?: number }): Promise<void> {
    let finished = false;
    await readSse(
      res,
      (m) => {
        const e = decodeChatEvent(m);
        if (!e) return;
        if (e.type === 'done' || e.type === 'deferred' || e.type === 'error') finished = true;
        onEvent(e);
      },
      { idleMs: o.idleMs ?? CHAT_IDLE_MS, signal: o.signal },
    );
    if (!finished) throw new StreamDroppedError('ended_early');
  }

  /**
   * One turn. Events arrive through `onEvent` as they stream. Throws NetworkError (never reached the
   * server), ApiError (refused before the stream), StreamDroppedError (cut off or silent before the end).
   */
  async chat(body: ChatMessageIn, onEvent: (e: ChatEvent) => void, o: { signal?: AbortSignal; idleMs?: number } = {}): Promise<void> {
    const res = await this.client.openStream('POST', '/chat/messages', { body, signal: o.signal });
    await this.readReply(res, onEvent, o);
  }

  /** A dropped reply, from after `lastEventId` («0» = from the start); a finished one comes as `snapshot`. */
  async resumeChat(
    replyId: string,
    lastEventId: string | null,
    onEvent: (e: ChatEvent) => void,
    o: { signal?: AbortSignal; idleMs?: number } = {},
  ): Promise<void> {
    const res = await this.client.openStream('GET', `/chat/messages/${encodeURIComponent(replyId)}/events`, {
      headers: { 'Last-Event-ID': lastEventId ?? '0' },
      signal: o.signal,
    });
    await this.readReply(res, onEvent, o);
  }

  /** Переписка (S36): oldest first; `before` pages back, `around` opens on one answer. */
  async chatHistory(q: { before?: string; around?: string; limit?: number } = {}): Promise<ChatHistoryOut> {
    const out = obj(await this.client.request<unknown>('GET', '/chat/messages', { query: { limit: 50, ...q } })) ?? {};
    return {
      messages: arr(out.messages).map(chatMessageOut).filter((m): m is ChatMessageOut => m !== null),
      has_more_before: out.has_more_before === true,
      has_more_after: out.has_more_after === true,
    };
  }

  /** One message (the plain JSON alternative to the resume stream). */
  async chatMessage(id: string): Promise<ChatMessageOut | null> {
    return chatMessageOut(await this.client.request<unknown>('GET', `/chat/messages/${encodeURIComponent(id)}`));
  }

  /** The answer that waits on «Сегодня» (the phone was gone when it was finished). */
  async pendingBanner(): Promise<PendingBannerOut> {
    const out = obj(await this.client.request<unknown>('GET', '/chat/pending-banner')) ?? {};
    return { message: chatMessageOut(out.message) };
  }

  /** «Отменить» an action (whole, or `item_ids` only). `410 undo_expired` after 30 days. */
  async undoAction(actionId: string, body: ActionUndoIn = {}): Promise<ActionUndoOut> {
    const out =
      obj(await this.client.request<unknown>('POST', `/actions/${encodeURIComponent(actionId)}/undo`, { body })) ?? {};
    return {
      action: actionOut(out.action),
      undo: actionOut(out.undo),
      partial: out.partial === true,
      repeated: out.repeated === true,
      message_ru: str(out.message_ru),
      page_patches: arr(out.page_patches).map(pagePatchOut).filter((x): x is PagePatchOut => x !== null),
    };
  }

  chatDelivery(messageId: string, delivery: ChatDeliveryState): Promise<unknown> {
    return this.client.request('POST', `/chat/messages/${encodeURIComponent(messageId)}/delivery`, { body: { delivery } });
  }

  // feedback («Сообщить о проблеме», R-41)
  sendFeedback(body: FeedbackIn): Promise<FeedbackOut> {
    return this.client.request('POST', '/feedback', { body, idempotencyKey: body.client_id });
  }
}

/** Data of a push → «Ответ готов», or null when it is some other notification. */
export function answerReadyFrom(data: unknown): AnswerReadyPushData | null {
  const o = obj(data);
  if (!o || o.type !== 'chat_reply') return null;
  return { type: 'chat_reply', reply_id: str(o.reply_id) };
}
