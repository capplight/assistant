import type { ApiClient } from './client';
import { ApiError } from './errors';
import { readSse, StreamDroppedError, type SseMessage } from './sse';
import type {
  ActionChangeOut,
  ActionOut,
  ActionUndoIn,
  ActionUndoOut,
  AnswerReadyPushData,
  ItemMoveIn,
  ManualOut,
  MoveReason,
  MoveToPageIn,
  PageItemOut,
  PagePatchOut,
  PagesReorderIn,
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
  FireOut,
  FiresWindowOut,
  ReminderActiveOut,
  ReminderCreateIn,
  ReminderDraft,
  ReminderEventsOut,
  ReminderEventIn,
  ReminderOut,
  ReminderParseIn,
  ReminderParseOut,
  ReminderPushData,
  ReminderSettingsOut,
  ReminderWithFiresOut,
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

function pageOutOf(v: unknown): PageOut | null {
  const o = obj(v);
  return o && str(o.id) && typeof o.position === 'string' ? (o as unknown as PageOut) : null;
}

const MOVE_REASONS = new Set<string>(['newer_move', 'anchor_gone', 'nothing_to_do', 'page_removed']);

/**
 * Week 7 answers (pages.md «Manual order»): `link` (move, DELETE) or `links` (move-to-page), and the
 * rows of `page_patch` / `page_patches`; `page` (reorder). The record's own rows come first, so
 * they win over the same row in a patch.
 */
export function manualOut(v: unknown): ManualOut {
  const o = obj(v) ?? {};
  const rows: PageItemOut[] = [];
  const removed: { page_id: string; item_id: string }[] = [];
  const add = (x: unknown) => {
    const l = linkOut(x);
    if (l && !rows.some((r) => r.page_id === l.page_id && r.item_id === l.item_id)) rows.push(l);
  };
  add(o.link);
  arr(o.links).forEach(add);
  const versions: { page_id: string; view_version: number }[] = [];
  for (const p of [o.page_patch, ...arr(o.page_patches)].map(pagePatchOut)) {
    if (!p) continue;
    p.rows.forEach(add);
    removed.push(...p.removed_item_ids.map((item_id) => ({ page_id: p.page_id, item_id })));
    versions.push({ page_id: p.page_id, view_version: p.view_version });
  }
  const page = pageOutOf(o.page);
  const reason = str(o.reason);
  return {
    // `removed` is the DELETE's word for it.
    moved: o.moved === true || o.removed === true,
    reason: reason && MOVE_REASONS.has(reason) ? (reason as MoveReason) : null,
    rows,
    removed,
    pages: page ? [page] : [],
    view_versions: versions,
    action: actionOut(o.action),
    learned_ru: str(o.learned_ru),
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

// --- week 8: reminders (docs/api/reminders.md) ---

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const nums = (v: unknown): number[] => arr(v).filter((x): x is number => typeof x === 'number');

function localOut(v: unknown): { date: string; time: string } | null {
  const o = obj(v);
  const date = o && str(o.date);
  const time = o && str(o.time);
  return date && time ? { date, time } : null;
}

export function reminderOut(v: unknown): ReminderOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const dueAt = o && str(o.due_at);
  if (!o || !id || !dueAt) return null;
  const now = new Date().toISOString();
  return {
    id,
    client_id: str(o.client_id),
    title: str(o.title) ?? '',
    body: str(o.body),
    due_at: dueAt,
    tz: str(o.tz) ?? 'Asia/Almaty',
    local: localOut(o.local),
    rrule: str(o.rrule),
    offsets: nums(o.offsets),
    level: o.level === 'notification' ? 'notification' : 'alarm',
    kind: o.kind === 'test' ? 'test' : 'normal',
    created_via: (str(o.created_via) as ReminderOut['created_via']) ?? null,
    parse_source: (str(o.parse_source) as ReminderOut['parse_source']) ?? null,
    sensitivity: o.sensitivity === 'health' ? 'health' : null,
    status: (str(o.status) as ReminderOut['status']) ?? 'scheduled',
    snooze_until: str(o.snooze_until),
    item_id: str(o.item_id),
    when_text: str(o.when_text),
    version: num(o.version, 1),
    seq: num(o.seq),
    created_at: str(o.created_at) ?? now,
    updated_at: str(o.updated_at) ?? now,
    deleted_at: str(o.deleted_at),
  };
}

const FIRE_STATES = new Set(['planned', 'fired', 'acked', 'snoozed', 'missed', 'cancelled']);

export function fireOut(v: unknown): FireOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const reminderId = o && str(o.reminder_id);
  const fireAt = o && str(o.fire_at);
  if (!o || !id || !reminderId || !fireAt) return null;
  const occurrence = str(o.occurrence_at) ?? fireAt;
  const offset = num(o.offset_min);
  const snooze = num(o.snooze_n);
  return {
    id,
    reminder_id: reminderId,
    key: str(o.key) ?? `${reminderId}:${occurrence}:${offset}:${snooze}`,
    occurrence_at: occurrence,
    fire_at: fireAt,
    offset_min: offset,
    snooze_n: snooze,
    repeat_n: num(o.repeat_n),
    state: (FIRE_STATES.has(String(o.state)) ? o.state : 'planned') as FireOut['state'],
    target_device_id: str(o.target_device_id),
    seq: num(o.seq),
    updated_at: str(o.updated_at) ?? new Date().toISOString(),
  };
}

export const remindersOf = (v: unknown) => arr(v).map(reminderOut).filter((x): x is ReminderOut => x !== null);
export const firesOf = (v: unknown) => arr(v).map(fireOut).filter((x): x is FireOut => x !== null);

function withFires(v: unknown): ReminderWithFiresOut {
  const o = obj(v) ?? {};
  return { reminder: reminderOut(o.reminder), fires: firesOf(o.fires) };
}

function draftOut(v: unknown): ReminderDraft | null {
  const o = obj(v);
  const title = o && str(o.title);
  if (!o || title === null) return null;
  return {
    title,
    due_at: str(o.due_at),
    tz: str(o.tz) ?? 'Asia/Almaty',
    local: localOut(o.local),
    rrule: str(o.rrule),
    offsets: nums(o.offsets),
    level: o.level === 'alarm' ? 'alarm' : 'notification',
    time_assumed: o.time_assumed === true,
    when_text: str(o.when_text),
    saved_text: str(o.saved_text),
  };
}

const PARSE_REASONS = new Set(['not_understood', 'no_ai', 'ai_unavailable', 'check_failed', 'past']);

export function parseOut(v: unknown): ReminderParseOut {
  const o = obj(v) ?? {};
  const status = o.status === 'ok' || o.status === 'ambiguous' ? o.status : 'form';
  const reason = str(o.reason);
  return {
    status,
    source: o.source === 'rules' || o.source === 'llm' ? o.source : null,
    reason: reason && PARSE_REASONS.has(reason) ? (reason as ReminderParseOut['reason']) : null,
    message: str(o.message),
    draft: draftOut(o.draft),
    options: arr(o.options).map(draftOut).filter((x): x is ReminderDraft => x !== null),
    parser: o.parser === 'rules_first' || o.parser === 'llm' ? o.parser : null,
  };
}

/** Data of a reminder push → what to refresh / open; null for any other push. */
export function reminderPushFrom(data: unknown): ReminderPushData | null {
  const o = obj(data);
  if (!o || (o.type !== 'reminder_backup' && o.type !== 'reminder_missed')) return null;
  return { type: o.type, fire_id: str(o.fire_id), reminder_id: str(o.reminder_id) };
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

  // week 7: by hand (F-41). Every call is idempotent by `client_id` (the outbox row).

  /** «Выше / Ниже / перетащил» → a new key between the neighbours, `manual_order=true`. */
  async moveItem(pageId: string, body: ItemMoveIn): Promise<ManualOut> {
    const path = `/pages/${encodeURIComponent(pageId)}/items/move`;
    return manualOut(await this.client.request<unknown>('POST', path, { body, idempotencyKey: body.client_id }));
  }

  /** S39: move to another page, or show there too. */
  async moveToPage(itemId: string, body: MoveToPageIn): Promise<ManualOut> {
    const path = `/items/${encodeURIComponent(itemId)}/move-to-page`;
    return manualOut(await this.client.request<unknown>('POST', path, { body, idempotencyKey: body.client_id }));
  }

  /** «Убрать с этой страницы»: the row stays as `removed_at`, the assistant does not bring it back. */
  async removeFromPage(pageId: string, itemId: string, clientId: string): Promise<ManualOut> {
    const path = `/pages/${encodeURIComponent(pageId)}/items/${encodeURIComponent(itemId)}`;
    return manualOut(
      await this.client.request<unknown>('DELETE', path, { query: { client_id: clientId }, idempotencyKey: clientId }),
    );
  }

  /** S34: the tab order. */
  async reorderPages(body: PagesReorderIn): Promise<ManualOut> {
    return manualOut(await this.client.request<unknown>('POST', '/pages/reorder', { body, idempotencyKey: body.client_id }));
  }

  /** S34 «Убрать»: soft delete, the records stay. Repeatable. */
  removePage(pageId: string): Promise<PageOut> {
    return this.client.request('DELETE', `/pages/${encodeURIComponent(pageId)}`);
  }

  /** «Отменить» of «Убрать»: the old rows and order are back. */
  restorePage(pageId: string): Promise<PageOut> {
    return this.client.request('POST', `/pages/${encodeURIComponent(pageId)}/restore`);
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

  // reminders — docs/api/reminders.md

  async createReminder(body: ReminderCreateIn): Promise<ReminderWithFiresOut> {
    return withFires(await this.client.request<unknown>('POST', '/reminders', { body, idempotencyKey: body.client_id }));
  }

  deleteReminder(id: string): Promise<unknown> {
    return this.client.request('DELETE', `/reminders/${encodeURIComponent(id)}`);
  }

  /** The planning window (default now − 1 h … now + 14 days). */
  async reminderFires(q: { from?: string; to?: string } = {}): Promise<FiresWindowOut> {
    const o = obj(await this.client.request<unknown>('GET', '/reminders/fires', { query: q })) ?? {};
    return { device_id: str(o.device_id), fires: firesOf(o.fires), reminders: remindersOf(o.reminders) };
  }

  /** Nothing is saved: the result goes to S13, the reminder exists only after [Сохранить]. */
  async parseReminder(body: ReminderParseIn): Promise<ReminderParseOut> {
    return parseOut(await this.client.request<unknown>('POST', '/reminders/parse', { body }));
  }

  /** S15 «Проверить будильник»: `kind=test`, due in 1 minute, rings on this phone. */
  async reminderTest(): Promise<ReminderWithFiresOut> {
    return withFires(await this.client.request<unknown>('POST', '/reminders/test', { body: {} }));
  }

  async reminderEvents(events: ReminderEventIn[]): Promise<ReminderEventsOut> {
    const o = obj(await this.client.request<unknown>('POST', '/reminders/events', { body: { events } })) ?? {};
    type Result = ReminderEventsOut['results'][number];
    const results = arr(o.results)
      .map((x): Result | null => {
        const r = obj(x);
        const id = r && str(r.client_id);
        const st = r && str(r.status);
        return id && st ? { client_id: id, status: st as Result['status'] } : null;
      })
      .filter((x): x is Result => x !== null);
    return { results, fires: firesOf(o.fires) };
  }

  /** On start and return to the foreground (≤ 1/min): this phone becomes the one that rings (R-13). */
  async reminderActive(): Promise<ReminderActiveOut> {
    const o = obj(await this.client.request<unknown>('POST', '/reminders/active', { body: {} })) ?? {};
    return { device_id: str(o.device_id), retargeted: num(o.retargeted) };
  }

  async reminderSettings(): Promise<ReminderSettingsOut> {
    const o = obj(await this.client.request<unknown>('GET', '/reminders/settings')) ?? {};
    const repeat = nums(o.repeat_minutes);
    const policy = o.alarm_device_policy;
    return {
      parser: o.parser === 'rules_first' || o.parser === 'llm' ? o.parser : null,
      alarm_device_policy: policy === 'all' || policy === 'last_active' ? policy : null,
      snooze_minutes: num(o.snooze_minutes, 10),
      snooze_max_hours: num(o.snooze_max_hours, 48),
      repeat_minutes: repeat.length > 0 ? repeat : [5, 10, 15],
      horizon_days: num(o.horizon_days, 14),
    };
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
