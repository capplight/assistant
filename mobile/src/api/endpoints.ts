import type { ApiClient } from './client';
import { ApiError } from './errors';
import { readSse, StreamDroppedError, type SseMessage } from './sse';
import type {
  ActionChangeOut,
  ExpenseAggregateOut,
  ExpenseAggregateQuery,
  ExpenseCategoriesListOut,
  ExpenseCategoriesOut,
  ExpenseCategoriesReorderIn,
  ExpenseCategoryOut,
  ExpenseCreateIn,
  ExpenseOut,
  ExpensePatchIn,
  ExpenseWriteOut,
  ExpenseDuplicateOut,
  ExpenseMergeIn,
  ExpenseMergeOut,
  ReceiptDraftOut,
  ReceiptFromItemIn,
  ReceiptFromQrIn,
  ReceiptOut,
  StatementConfirmOut,
  StatementIn,
  StatementOut,
  StatementPlanOut,
  StatementRowOut,
  StatementStatus,
  StatementWithRowsOut,
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
  CollectionToPageOut,
  CustomFieldOut,
  CustomFieldType,
  DuplicatesMergeIn,
  DuplicatesMergeOut,
  FieldPrefOut,
  FieldType,
  ItemFacetOut,
  PageItemFieldsIn,
  PageItemFieldsOut,
  PageTemplateOut,
  PageViewIn,
  PageViewOut,
  SetBy,
  TemplateFieldOut,
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
  ActionsPageOut,
  HabitOut,
  HabitRemoveOut,
  HabitPatchOut,
  ReminderPatchIn,
  SuggestionAcceptOut,
  SuggestionOut,
  TaskCreateIn,
  TaskDoneIn,
  TaskPatchIn,
  TasksClearDoneIn,
  TasksClearDoneOut,
  NoteColor,
  AppearanceOut,
  TaskOut,
  TaskWriteOut,
  TodayOut,
  TodayReminderOut,
  CleanupPlanOut,
  CleanupPreview,
  CollectionOut,
  CollectionWriteOut,
  DuplicateDecisionIn,
  DuplicateDecisionOut,
  DuplicateGroupOut,
  DuplicateMemberOut,
  DuplicateStatus,
  ImportFileIn,
  ImportOut,
  ImportStatus,
  PendingActionOut,
  PendingConfirmOut,
  CompanyBankOut,
  CompanyProfileIn,
  CompanyProfileOut,
  CompanyProfileWriteOut,
  DocumentOut,
  DocumentStatus,
  DocumentStatusIn,
  KpCreateIn,
  KpFullOut,
  DocumentStatusOut,
  DealStatus,
  KpDataOut,
  KpItemOut,
  KpPatchIn,
  KpRenderOut,
  KpTotalsOut,
  KpVatMode,
  KpVersionOut,
  PriceItemOut,
  PriceItemPatchIn,
  PriceItemsIn,
  PriceItemsOut,
  PastPriceOut,
  PriceItemWriteOut,
  PriceSearchOut,
  UploadRole,
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
  if (!o) return null;
  const itemId = str(o.item_id);
  const text = str(o.text) ?? str(o.title);
  if (!itemId && !text) return null;
  return {
    item_id: itemId,
    task_id: str(o.task_id),
    reminder_id: str(o.reminder_id),
    title: str(o.title),
    kind: str(o.kind),
    text: str(o.text) ?? str(o.title) ?? '',
    page_id: str(o.page_id),
    reverted: o.reverted === true,
    key: str(o.key),
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
    initiated_by: o.initiated_by === 'user' || o.initiated_by === 'agent' ? o.initiated_by : null,
    scope: o.scope === 'external' || o.scope === 'internal' ? o.scope : null,
    created_at: str(o.created_at),
    seq: typeof o.seq === 'number' ? o.seq : 0,
    ...(str(o.event_client_id) ? { event_client_id: str(o.event_client_id) } : {}),
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
    ...('done_at' in o ? { done_at: str(o.done_at) } : {}),
    ...(obj(o.appearance) ? { appearance: appearanceOut(o.appearance) } : {}),
  };
}

const NOTE_COLOR_SET = new Set<string>(['yellow', 'pink', 'green', 'blue', 'peach', 'white']);
const setByOf = (v: unknown) => (v === 'user' || v === 'agent' || v === 'template' ? v : null);

/** `link.appearance` (views.md): an unknown colour reads as none. */
export function appearanceOut(v: unknown): AppearanceOut {
  const o = obj(v) ?? {};
  const c = str(o.color);
  const colorBy = setByOf(o.color_set_by);
  const pinnedBy = setByOf(o.pinned_set_by);
  return {
    color: c && NOTE_COLOR_SET.has(c) ? (c as NoteColor) : null,
    ...(colorBy ? { color_set_by: colorBy } : {}),
    ...(pinnedBy ? { pinned_set_by: pinnedBy } : {}),
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
  // Week 11 (views.md): `page_view` with the page's look; older shapes put `layout` beside.
  const pv = obj(d.page_view) ?? d;
  const layout = str(pv.layout);
  return {
    page_id: pageId,
    view_version: Number(d.view_version) || 0,
    view_state: vs ? { ...vs, ...(groups ? { groups } : {}) } : null,
    rows: arr(d.rows).map(linkOut).filter((x): x is PageItemOut => x !== null),
    removed_item_ids: strs(d.removed_item_ids),
    ...(layout ? { layout } : {}),
    ...(Array.isArray(pv.field_prefs) ? { field_prefs: fieldPrefsOf(pv.field_prefs) } : {}),
    ...(Array.isArray(pv.custom_fields) ? { custom_fields: customFieldsOf(pv.custom_fields) } : {}),
  };
}

/** `/v1/sync` `item_facets` (views.md «Sync»). */
export function itemFacetsOf(v: unknown): ItemFacetOut[] {
  return arr(v).flatMap((x): ItemFacetOut[] => {
    const o = obj(x);
    const pageId = o && str(o.page_id);
    const itemId = o && str(o.item_id);
    if (!o || !pageId || !itemId) return [];
    return [{ id: str(o.id) ?? `${pageId}|${itemId}`, page_id: pageId, item_id: itemId, data: obj(o.data) ?? {}, seq: num(o.seq) }];
  });
}

// --- week 11: view settings (template-screens 2.8, 4; docs/api/views.md) ---

const SET_BY = new Set<string>(['user', 'agent', 'template']);
const setBy = (v: unknown): SetBy | undefined => (typeof v === 'string' && SET_BY.has(v) ? (v as SetBy) : undefined);

/** `field_prefs`: `{field_id, visible, order, set_by?}`; unknown rows are dropped. */
export function fieldPrefsOf(v: unknown): FieldPrefOut[] {
  return arr(v).flatMap((x, i): FieldPrefOut[] => {
    const o = obj(x);
    const id = o && (str(o.field_id) ?? str(o.id));
    if (!o || !id) return [];
    const by = setBy(o.set_by);
    return [{ field_id: id, visible: o.visible !== false, order: num(o.order, i), ...(by ? { set_by: by } : {}) }];
  });
}

const CUSTOM_TYPES = new Set<string>(['text', 'number', 'money', 'date', 'bool']);

/** `custom_fields`: at most 5, five types; an unknown type reads as text. */
export function customFieldsOf(v: unknown): CustomFieldOut[] {
  return arr(v).flatMap((x, i): CustomFieldOut[] => {
    const o = obj(x);
    const id = o && str(o.id);
    const title = o && str(o.title);
    if (!o || !id || !title) return [];
    const type = (CUSTOM_TYPES.has(String(o.type)) ? o.type : 'text') as CustomFieldType;
    const by = setBy(o.set_by);
    return [{ id, title, type, order: num(o.order, i), visible: o.visible !== false, ...(by ? { set_by: by } : {}) }];
  });
}

const FIELD_TYPES = new Set<string>(['text', 'long_text', 'number', 'money', 'date', 'datetime', 'enum', 'tags', 'bool', 'person', 'link']);

function i18nText(v: unknown): { ru: string; kk: string | null } | null {
  const o = obj(v);
  const ru = o ? str(o.ru) : str(v);
  return ru ? { ru, kk: o ? str(o.kk) : null } : null;
}

export function templateFieldOut(v: unknown): TemplateFieldOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const title = o && i18nText(o.title);
  if (!o || !id || !title) return null;
  return {
    id,
    title,
    type: (FIELD_TYPES.has(String(o.type)) ? o.type : 'text') as FieldType,
    required: o.required === true,
    default_visible: o.default_visible !== false,
    source: str(o.source) ?? '',
    ...(Array.isArray(o.options) ? { options: strs(o.options) } : {}),
  };
}

/** One template of `GET /page-templates` (pages.md «Catalogue»). */
export function pageTemplateOut(v: unknown): PageTemplateOut | null {
  const o = obj(v);
  const key = o && str(o.key);
  if (!o || !key) return null;
  const layouts = strs(o.layouts);
  return {
    key,
    version: num(o.version, 1),
    title: i18nText(o.title) ?? { ru: key, kk: null },
    icon: str(o.icon) ?? 'other',
    singleton: o.singleton !== false,
    fields: arr(o.fields).map(templateFieldOut).filter((x): x is TemplateFieldOut => x !== null),
    layouts,
    default_layout: str(o.default_layout) ?? layouts[0] ?? 'list',
    default_view: obj(o.default_view),
    min_app_version: str(o.min_app_version),
  };
}

/** A page answer: `{page, action}`, or the page itself with `action` beside its fields. */
export function pageViewOut(v: unknown): PageViewOut {
  const o = obj(v) ?? {};
  const page = pageOutOf(o.page) ?? pageOutOf(o);
  return {
    page,
    action: actionOut(o.action),
    repeated: o.repeated === true,
    changed: o.changed !== false,
    page_patch: pagePatchOut(o.page_patch),
  };
}

/** «Сделать стопку страницей»: the new page, the stack as it is now, the action. */
export function collectionToPageOut(v: unknown): CollectionToPageOut {
  const o = obj(v) ?? {};
  return {
    page: pageOutOf(o.page),
    collection: collectionOut(o.collection),
    action: actionOut(o.action),
    repeated: o.repeated === true,
  };
}

function pageOutOf(v: unknown): PageOut | null {
  const o = obj(v);
  if (!o || !str(o.id) || typeof o.position !== 'string') return null;
  const out = o as unknown as PageOut;
  // Week 11 lists are read leniently; an older server has none (= as in the template).
  return {
    ...out,
    ...(o.field_prefs !== undefined ? { field_prefs: fieldPrefsOf(o.field_prefs) } : {}),
    ...(o.custom_fields !== undefined ? { custom_fields: customFieldsOf(o.custom_fields) } : {}),
  };
}

const MOVE_REASONS = new Set<string>(['newer_move', 'anchor_gone', 'nothing_to_do', 'page_removed', 'timed']);

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
/** Words a server may use for the «Да» of a deletion: shown and sent like `yes`. */
const YES_WORDS = new Set(['delete', 'trash', 'confirm', 'remove']);
const DELETE_KINDS = new Set(['delete', 'trash', 'confirm_delete', 'delete_items']);
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
      const kind = (OPTION_KINDS.has(String(o.kind)) ? o.kind : YES_WORDS.has(String(o.kind)) ? 'yes' : 'cancel') as ProposalOption['kind'];
      return { id: str(o.id) ?? String(i), label, kind, item_id: str(o.item_id) };
    })
    .filter((x): x is ProposalOption => x !== null);
  if (options.length === 0) return null;
  const isDelete = DELETE_KINDS.has(String(d.kind)) || DELETE_KINDS.has(String(d.action_kind));
  // A deletion never has «Да» in focus (2-design S25): the safe answer is the one focused first.
  let def = str(d.default);
  if (isDelete && (!def || options.find((o) => o.id === def)?.kind === 'yes')) {
    def = options.find((o) => o.kind !== 'yes')?.id ?? null;
  }
  return {
    reply_id: str(d.reply_id),
    kind: isDelete ? 'delete' : d.kind === 'count' || d.kind === 'manual' ? d.kind : 'choice',
    question,
    count: typeof d.count === 'number' ? d.count : null,
    item_ids: strs(d.item_ids),
    options,
    default: def,
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
        // Week 9: the tasks it made, for instant display (today.md «From the assistant line»).
        const tasks = tasksOf(d.tasks ?? obj(d.action)?.tasks);
        // Week 12 (expenses.md «From the line»): the expenses it saved, so the totals change at once.
        const expenses = expensesOf(d.expenses ?? obj(d.action)?.expenses);
        return { type: 'action', action, changedItemIds: ids.length > 0 ? ids : action.changed_item_ids, tasks, expenses };
      }
      case 'reminder_draft': {
        // Week 9 (reminders.md «From the assistant line»): S13, nothing is saved.
        const via = d.created_via === 'voice' ? 'voice' : 'typed';
        return { type: 'reminder_draft', replyId: str(d.reply_id), draft: parseOut(d), createdVia: via };
      }
      case 'page_patch': {
        const patch = pagePatchOut(d);
        return patch ? { type: 'page_patch', patch } : null;
      }
      case 'needs_choice':
      case 'confirm':
      case 'confirm_manual':
      case 'confirm_delete': {
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
  return { reminder: reminderOut(o.reminder), fires: firesOf(o.fires), action: actionOut(o.action) };
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


// --- week 9: tasks, «Сегодня», suggestions, actions list, habits (today.md, actions.md, pages.md) ---

export function taskOut(v: unknown): TaskOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  if (!o || !id) return null;
  const now = new Date().toISOString();
  const doneAt = str(o.done_at);
  return {
    id,
    client_id: str(o.client_id),
    item_id: str(o.item_id),
    list_key: o.list_key === 'shopping' ? 'shopping' : 'todo',
    title: str(o.title) ?? '',
    qty: str(o.qty),
    where: str(o.where),
    due_date: str(o.due_date),
    done: typeof o.done === 'boolean' ? o.done : !!doneAt,
    done_at: doneAt,
    version: num(o.version, 1),
    seq: num(o.seq),
    created_at: str(o.created_at) ?? now,
    updated_at: str(o.updated_at) ?? now,
    deleted_at: str(o.deleted_at),
  };
}

export const tasksOf = (v: unknown) => arr(v).map(taskOut).filter((x): x is TaskOut => x !== null);
export const actionsOf = (v: unknown) => arr(v).map(actionOut).filter((x): x is ActionOut => x !== null);

function taskWrite(v: unknown): TaskWriteOut {
  const o = obj(v) ?? {};
  return {
    task: taskOut(o.task),
    action: actionOut(o.action),
    page_patches: arr(o.page_patches).map(pagePatchOut).filter((x): x is PagePatchOut => x !== null),
    repeated: o.repeated === true,
  };
}

export function suggestionOut(v: unknown): SuggestionOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const text = o && str(o.text_ru);
  if (!o || !id || !text) return null;
  const d = obj(o.do);
  const type = d ? str(d.type) : null;
  return {
    id,
    kind: str(o.kind) ?? 'tip',
    key: str(o.key) ?? '',
    text_ru: text,
    yes_label: str(o.yes_label),
    no_label: str(o.no_label),
    do: d && type ? { type, phrase: str(d.phrase), page_id: str(d.page_id) } : null,
    status: str(o.status) ?? 'shown',
    expires_at: str(o.expires_at),
    seq: num(o.seq),
  };
}

export const suggestionsOf = (v: unknown) => arr(v).map(suggestionOut).filter((x): x is SuggestionOut => x !== null);

function todayReminderOut(v: unknown): TodayReminderOut | null {
  const o = obj(v);
  const reminder = o ? reminderOut(o.reminder) : null;
  if (!o || !reminder) return null;
  return {
    reminder,
    fire: fireOut(o.fire),
    occurrence_at: str(o.occurrence_at) ?? reminder.due_at,
    local_time: str(o.local_time),
    state: str(o.state),
  };
}

const todayReminders = (v: unknown) => arr(v).map(todayReminderOut).filter((x): x is TodayReminderOut => x !== null);

export function todayOut(v: unknown): TodayOut {
  const o = obj(v) ?? {};
  const today = obj(o.today) ?? {};
  const shop = obj(today.shopping);
  const done = obj(o.done_for_you) ?? {};
  return {
    date: str(o.date),
    tz: str(o.tz),
    greeting: str(o.greeting),
    sections: strs(o.sections),
    today: {
      reminders: todayReminders(today.reminders),
      tasks: tasksOf(today.tasks),
      shopping: shop ? { page_id: str(shop.page_id), count: num(shop.count), titles: strs(shop.titles) } : null,
    },
    missed: todayReminders(o.missed),
    done_for_you: { actions: actionsOf(done.actions), count_today: num(done.count_today) },
    banner: chatMessageOut(o.banner),
    proposals: suggestionsOf(o.proposals).slice(0, 2),
    tip: suggestionOut(o.tip),
    empty: o.empty === true,
    example: str(o.example),
  };
}

export const habitsOf = (v: unknown) => arr(v).map(habitOut).filter((x): x is HabitOut => x !== null);

export function habitOut(v: unknown): HabitOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const text = o && str(o.text_ru);
  if (!o || !id || !text) return null;
  return {
    id,
    kind: str(o.kind) ?? 'habit',
    text_ru: text,
    text_kk: str(o.text_kk),
    page: pageRef(o.page),
    item_id: str(o.item_id),
    status: str(o.status) ?? 'active',
    evidence_count: num(o.evidence_count),
    seq: num(o.seq),
    updated_at: str(o.updated_at),
  };
}

// --- week 10: repeats, stacks, Telegram import (3-engineering §4.6, §4.9; see types.ts) ---

const DUP_STATUSES = new Set(['auto_merged', 'suggested', 'merged', 'dismissed', 'undone']);

function memberOut(v: unknown): DuplicateMemberOut | null {
  const o = obj(v);
  // A member may come as a bare item id, or with the item nested (`item: {id, title, …}`).
  if (typeof v === 'string') return { item_id: v, role: 'merge', title: null, snippet: null, kind: null, occurred_at: null, created_at: null, score: null };
  const item = o ? (obj(o.item) ?? o) : null;
  const id = o && (str(o.item_id) ?? (item ? str(item.id) : null));
  if (!o || !item || !id) return null;
  return {
    item_id: id,
    role: o.role === 'keep' ? 'keep' : 'merge',
    title: str(item.title),
    snippet: str(item.snippet) ?? str(item.preview) ?? str(item.text),
    kind: str(item.kind),
    occurred_at: str(item.occurred_at),
    created_at: str(item.created_at),
    score: typeof o.score === 'number' ? o.score : null,
  };
}

export function duplicateGroupOut(v: unknown): DuplicateGroupOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  if (!o || !id) return null;
  const members = arr(o.members ?? o.items).map(memberOut).filter((x): x is DuplicateMemberOut => x !== null);
  const keep = str(o.keep_item_id) ?? members.find((m) => m.role === 'keep')?.item_id ?? null;
  return {
    id,
    kind: o.kind === 'exact' ? 'exact' : 'near',
    status: (DUP_STATUSES.has(String(o.status)) ? o.status : 'suggested') as DuplicateStatus,
    keep_item_id: keep,
    keep_rule: str(o.keep_rule),
    member_count: num(o.member_count, members.length),
    origin: str(o.origin),
    members: members.map((m) => ({ ...m, role: m.item_id === keep ? 'keep' : 'merge' })),
    action_id: str(o.action_id),
    seq: num(o.seq),
    created_at: str(o.created_at),
    decided_at: str(o.decided_at),
  };
}

export const duplicateGroupsOf = (v: unknown) =>
  arr(v).map(duplicateGroupOut).filter((x): x is DuplicateGroupOut => x !== null);

export function pendingActionOut(v: unknown): PendingActionOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  if (!o || !id) return null;
  return {
    id,
    kind: str(o.kind) ?? 'pending',
    status: str(o.status) ?? 'proposed',
    preview: obj(o.preview) ?? {},
    expires_at: str(o.expires_at),
    action_id: str(o.action_id),
    seq: num(o.seq),
    created_at: str(o.created_at),
  };
}

export const pendingActionsOf = (v: unknown) =>
  arr(v).map(pendingActionOut).filter((x): x is PendingActionOut => x !== null);

/** The numbers of a `cleanup_batch` preview; null when it has none to show. */
export function cleanupPreview(p: PendingActionOut | null): CleanupPreview | null {
  if (!p) return null;
  const v = p.preview;
  // duplicates.md: `copies`, `records_before`, `records_after`, `groups`.
  const before = num(v.records_before ?? v.before);
  const after = num(v.records_after ?? v.after, before - num(v.copies ?? v.removed));
  const removed = num(v.copies ?? v.removed, before - after);
  if (removed <= 0) return null;
  return { before, after, removed, groups: num(v.groups ?? v.group_count) };
}

function beforeAfter(v: unknown): CollectionOut['before_after'] {
  const o = obj(v);
  if (!o) return null;
  const n = (x: unknown) => (typeof x === 'number' ? x : null);
  return { before: n(o.before), after: n(o.after), removed: n(o.removed ?? o.repeats_removed) };
}

export function collectionOut(v: unknown): CollectionOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const title = o && str(o.title);
  if (!o || !id || !title) return null;
  return {
    id,
    page_id: str(o.page_id) ?? str(o.screen_id),
    kind: str(o.kind) ?? 'smart',
    title,
    title_kk: str(o.title_kk),
    icon: str(o.icon) ?? 'other',
    item_count: num(o.item_count),
    before_after: beforeAfter(o.before_after),
    created_by: str(o.created_by),
    last_opened_at: str(o.last_opened_at),
    hidden_at: str(o.hidden_at),
    seq: num(o.seq),
    updated_at: str(o.updated_at),
    deleted_at: str(o.deleted_at),
  };
}

export const collectionsOf = (v: unknown) => arr(v).map(collectionOut).filter((x): x is CollectionOut => x !== null);

function collectionWrite(v: unknown): CollectionWriteOut {
  const o = obj(v) ?? {};
  return {
    collection: collectionOut(o.collection),
    action: actionOut(o.action),
    page_patches: arr(o.page_patches).map(pagePatchOut).filter((x): x is PagePatchOut => x !== null),
  };
}

const IMPORT_STATUSES = new Set(['created', 'awaiting_code', 'running', 'paused_budget', 'done', 'failed', 'cancelled']);

export function importOut(v: unknown): ImportOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  if (!o || !id) return null;
  const summary = obj(o.summary) ?? {};
  const pick = (k: string) => o[k] ?? summary[k];
  const media: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(pick('skipped_media')) ?? {})) if (typeof n === 'number' && n > 0) media[k] = n;
  return {
    id,
    client_id: str(o.client_id),
    source: str(o.source) ?? 'telegram_export_file',
    status: (IMPORT_STATUSES.has(String(o.status)) ? o.status : 'created') as ImportStatus,
    total: num(pick('total')),
    processed: num(pick('processed')),
    created_count: num(pick('created_count') ?? pick('created')),
    skipped_dups: num(pick('skipped_dups')),
    seen_before: num(pick('seen_before')),
    summary_ru: str(pick('summary_ru')),
    skipped_media: media,
    failed: num(pick('failed')),
    stacks: num(pick('stacks') ?? pick('stack_count')),
    similar_groups: num(pick('similar_groups') ?? pick('near_groups')),
    cleanup: pendingActionOut(pick('cleanup') ?? pick('pending_action')),
    action_id: str(o.action_id),
    error: str(o.error),
    seq: num(o.seq),
    started_at: str(o.started_at),
    finished_at: str(o.finished_at),
  };
}

export const importsOf = (v: unknown) => arr(v).map(importOut).filter((x): x is ImportOut => x !== null);

// --- week 14: КП (docs/api/kp.md) ---

const VAT_MODES = new Set<string>(['included', 'on_top', 'none']);
const DOC_STATES = new Set<string>(['extracting', 'draft', 'ready', 'sent', 'accepted', 'declined', 'archived', 'failed']);
const vatMode = (v: unknown, d: KpVatMode = 'included'): KpVatMode => (typeof v === 'string' && VAT_MODES.has(v) ? (v as KpVatMode) : d);
/** A decimal as text; a JSON number is taken as its plain text (never rounded here). */
const decText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

function bankOut(v: unknown): CompanyBankOut {
  const o = obj(v) ?? {};
  return { iban: str(o.iban), bik: str(o.bik), bank: str(o.bank), kbe: str(o.kbe) };
}

export function companyProfileOut(v: unknown): CompanyProfileOut {
  const o = obj(obj(v)?.profile ?? v) ?? {};
  const c = obj(o.contacts) ?? {};
  const name = str(o.name);
  const bin = str(o.bin_iin);
  return {
    name,
    legal_form: str(o.legal_form),
    bin_iin: bin,
    address: str(o.address),
    bank: bankOut(o.bank),
    contacts: { phone: str(c.phone), email: str(c.email), website: str(c.website) },
    vat_payer: typeof o.vat_payer === 'boolean' ? o.vat_payer : null,
    logo_file_id: str(o.logo_file_id),
    signature_file_id: str(o.signature_file_id),
    stamp_file_id: str(o.stamp_file_id),
    review_fields: strs(o.review_fields),
    version: num(o.version, 0),
    complete: typeof o.complete === 'boolean' ? o.complete : !!(name && bin),
    updated_at: str(o.updated_at),
  };
}

export function priceItemOut(v: unknown): PriceItemOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const name = o && str(o.name);
  const price = o && decText(o.price);
  if (!o || !id || !name || !price) return null;
  return {
    id,
    client_id: str(o.client_id),
    price_list_id: str(o.price_list_id),
    name,
    unit: str(o.unit),
    price,
    currency: (str(o.currency) ?? 'KZT').toUpperCase(),
    review: strs(o.review_fields).length > 0,
    source_ref: str(o.source_ref),
    updated_at: str(o.updated_at),
    deleted_at: str(o.deleted_at),
  };
}

export const priceItemsOf = (v: unknown) => arr(v).map(priceItemOut).filter((x): x is PriceItemOut => x !== null);

export function pastPriceOut(v: unknown): PastPriceOut | null {
  const o = obj(v);
  const name = o && str(o.name);
  const price = o && decText(o.price);
  if (!o || !name || !price) return null;
  return {
    name,
    unit: str(o.unit),
    price,
    currency: (str(o.currency) ?? 'KZT').toUpperCase(),
    price_source: str(o.price_source) ?? '',
    client: str(o.client),
    created_at: str(o.created_at),
  };
}

function kpItemOut(v: unknown, i: number): KpItemOut | null {
  const o = obj(v);
  const name = o && str(o.name);
  if (!o || !name) return null;
  const price = decText(o.unit_price);
  return {
    id: str(o.id) ?? `i${i + 1}`,
    name,
    unit: str(o.unit),
    qty: decText(o.qty),
    unit_price: price,
    discount_pct: decText(o.discount_pct) ?? '0',
    price_source: str(o.price_source) ?? (price ? 'manual' : 'missing'),
    price_label: str(o.price_label) || null,
    price_review: o.price_review === true,
    matched_name: str(o.matched_name),
    source_ref: str(o.source_ref),
    review_fields: strs(o.review_fields),
    amount: decText(o.amount),
  };
}

function kpTotalsOut(v: unknown): KpTotalsOut | null {
  const o = obj(v);
  const total = o && decText(o.total);
  if (!o || !total) return null;
  return {
    lines_sum: decText(o.lines_sum) ?? total,
    discount_total: decText(o.discount_total) ?? '0.00',
    amount: decText(o.amount) ?? total,
    net: decText(o.net) ?? total,
    vat: decText(o.vat) ?? '0.00',
    total,
    vat_rate: decText(o.vat_rate),
    rounding: o.rounding === 'per_line' ? 'per_line' : 'on_total',
    priced: num(o.priced),
    missing: num(o.missing),
    complete: o.complete === true,
    calc_version: str(o.calc_version),
  };
}

/** `version_dict`: `data` (no client, no items), `client`, `items`, `totals`, `vat_rate`, `vat_mode`. */
export function kpVersionOut(v: unknown): KpVersionOut | null {
  const o = obj(v);
  if (!o) return null;
  const d = obj(o.data) ?? {};
  const client = obj(o.client) ?? obj(d.client) ?? {};
  const vat = obj(d.vat) ?? {};
  const terms = obj(d.terms) ?? {};
  const totals = kpTotalsOut(o.totals);
  const ps = obj(o.price_summary) ?? {};
  const data: KpDataOut = {
    number: str(d.number),
    date: str(d.date),
    currency: (str(d.currency) ?? 'KZT').toUpperCase(),
    client: { name: str(client.name), bin: str(client.bin), contact: str(client.contact), review: strs(client.review) },
    vat: {
      mode: vatMode(vat.mode ?? o.vat_mode),
      rate: decText(vat.rate) ?? decText(o.vat_rate) ?? totals?.vat_rate ?? null,
      rounding: (vat.rounding ?? totals?.rounding) === 'per_line' ? 'per_line' : 'on_total',
    },
    items: arr(o.items ?? d.items)
      .map(kpItemOut)
      .filter((x): x is KpItemOut => x !== null),
    discount_total_pct: decText(d.discount_total_pct) ?? '0',
    terms: Object.fromEntries(
      Object.entries(terms).filter(([, x]) => typeof x === 'string' || typeof x === 'number' || x === null),
    ) as KpDataOut['terms'],
  };
  return {
    n: num(o.n, 1),
    author: str(o.author) ?? 'initial',
    created_at: str(o.created_at),
    data,
    totals,
    changed_paths: strs(o.changed_paths),
    valid_until: str(o.valid_until),
    price_summary: { price_list: num(ps.price_list), past_kp: num(ps.past_kp), manual: num(ps.manual), missing: num(ps.missing) },
    missing_required: strs(o.missing_required),
    sent_at: str(o.sent_at),
    ai_generated: o.ai_generated !== false,
  };
}

const DEALS = new Set<string>(['draft', 'sent', 'seen', 'accepted', 'declined']);

export function documentOut(v: unknown): DocumentOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  if (!o || !id) return null;
  const status = str(o.status);
  const deal = str(o.deal_status);
  const progress = obj(o.progress);
  const client = obj(o.client);
  return {
    id,
    client_id: str(o.client_id),
    item_id: str(o.item_id),
    kind: str(o.kind) ?? 'kp',
    title: str(o.title),
    number: str(o.number),
    date: str(o.date),
    client_name: str(client?.name),
    currency: (str(o.currency) ?? 'KZT').toUpperCase(),
    total: decText(o.total),
    missing_prices: num(o.missing_prices),
    lines: num(o.lines),
    status: (status && DOC_STATES.has(status) ? status : 'draft') as DocumentStatus,
    deal_status: (deal && DEALS.has(deal) ? deal : 'draft') as DealStatus,
    current_version_n: typeof o.current_version_n === 'number' ? o.current_version_n : null,
    sent_version_n: typeof o.sent_version_n === 'number' ? o.sent_version_n : null,
    progress:
      progress && Object.keys(progress).length > 0
        ? { state: str(progress.state), done: num(progress.done), total: num(progress.total), message: str(progress.message), partial: progress.partial === true }
        : null,
    error: str(o.error),
    ai_generated: o.ai_generated !== false,
    row_version: num(o.version, 1),
    seq: num(o.seq),
    created_at: str(o.created_at),
    updated_at: str(o.updated_at),
    deleted_at: str(o.deleted_at),
  };
}

export const documentsOf = (v: unknown) => arr(v).map(documentOut).filter((x): x is DocumentOut => x !== null);

export function kpFullOut(v: unknown): KpFullOut {
  const o = obj(v) ?? {};
  const document = documentOut(o.document);
  if (!document) throw new ApiError(502, { code: 'bad_answer' });
  const offers = arr(o.price_offers).flatMap((x) => {
    const p = obj(x);
    const name = p && str(p.name);
    const price = p && decText(p.price);
    return p && name && price
      ? [{ line_id: str(p.line_id) ?? '', name, unit: str(p.unit), price, price_item_id: str(p.price_item_id), old_price: decText(p.old_price) }]
      : [];
  });
  return {
    document,
    version: kpVersionOut(o.version),
    needs_profile: o.needs_profile === true,
    action: actionOut(o.action),
    change_text: str(o.change_text),
    price_offers: offers,
    repeated: o.repeated === true,
  };
}

/** Typed /v1 endpoints. The ONLY place that knows paths and request bodies. */
// --- week 12: «Расходы» (docs/api/expenses.md) ---

const DIRECTIONS = new Set<string>(['expense', 'income', 'refund', 'transfer_own']);
const METHODS = new Set<string>(['cash', 'card', 'kaspi', 'transfer', 'other']);
const PARSE_SOURCES = new Set<string>(['rules', 'llm', 'user_edit']);

/** Money is text: the server's decimal string as it is. A JSON number (never in the contract) is refused, not rounded. */
const money = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

export function expenseOut(v: unknown): ExpenseOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const amount = o && money(o.amount);
  const spentOn = o && str(o.spent_on);
  if (!o || !id || !amount || !spentOn) return null;
  const now = new Date().toISOString();
  const method = str(o.method);
  const ps = str(o.parse_source);
  return {
    id,
    client_id: str(o.client_id),
    item_id: str(o.item_id),
    amount,
    currency: (str(o.currency) ?? 'KZT').toUpperCase(),
    expression: str(o.expression),
    spent_on: spentOn.slice(0, 10),
    category_id: str(o.category_id),
    category_key: str(o.category_key),
    payee: str(o.payee),
    method: method && METHODS.has(method) ? (method as ExpenseOut['method']) : null,
    direction: typeof o.direction === 'string' && DIRECTIONS.has(o.direction) ? (o.direction as ExpenseOut['direction']) : 'expense',
    note: str(o.note),
    source: str(o.source) ?? 'form',
    parse_source: ps && PARSE_SOURCES.has(ps) ? (ps as ExpenseOut['parse_source']) : null,
    review_fields: strs(o.review_fields),
    line_items: lineItems(o.line_items),
    statement_id: str(o.statement_id),
    ai_generated: o.ai_generated === true,
    version: num(o.version, 1),
    seq: num(o.seq),
    created_at: str(o.created_at) ?? now,
    updated_at: str(o.updated_at) ?? now,
    deleted_at: str(o.deleted_at),
  };
}

export const expensesOf = (v: unknown) => arr(v).map(expenseOut).filter((x): x is ExpenseOut => x !== null);

export function expenseCategoryOut(v: unknown): ExpenseCategoryOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const key = o && str(o.key);
  const title = o && str(o.title);
  if (!o || !id || !key || !title) return null;
  return {
    id,
    client_id: str(o.client_id),
    key,
    title,
    title_kk: str(o.title_kk),
    icon: str(o.icon),
    system: o.system === true,
    service: o.service === true || key === 'transfers',
    position: str(o.position),
    manual: o.manual === true,
    pinned: o.pinned === true,
    hidden: o.hidden === true || !!str(o.hidden_at),
    version: num(o.version, 1),
    seq: num(o.seq),
  };
}

export const expenseCategoriesOf = (v: unknown) =>
  arr(v).map(expenseCategoryOut).filter((x): x is ExpenseCategoryOut => x !== null);

function expenseWrite(v: unknown): ExpenseWriteOut {
  const o = obj(v) ?? {};
  return {
    expense: expenseOut(o.expense),
    action: actionOut(o.action),
    page_patches: arr(o.page_patches).map(pagePatchOut).filter((x): x is PagePatchOut => x !== null),
    repeated: o.repeated === true,
  };
}

export function expenseAggregateOut(v: unknown): ExpenseAggregateOut {
  const o = obj(v) ?? {};
  const p = obj(o.period);
  const totals = arr(o.totals)
    .map((x) => {
      const t = obj(x);
      const total = t && money(t.total);
      const currency = t && str(t.currency);
      if (!t || !total || !currency) return null;
      return { currency, total, expense: money(t.expense), refund: money(t.refund), income: money(t.income), count: num(t.count) };
    })
    .filter((x): x is ExpenseAggregateOut['totals'][number] => x !== null);
  const groups = arr(o.groups)
    .map((x) => {
      const g = obj(x);
      const total = g && money(g.total);
      return g && total ? { key: str(g.key), title: str(g.title), currency: str(g.currency) ?? 'KZT', total, count: num(g.count) } : null;
    })
    .filter((x): x is ExpenseAggregateOut['groups'][number] => x !== null);
  return {
    calc_version: str(o.calc_version),
    period: p && str(p.from) && str(p.to) ? { kind: str(p.kind) ?? 'custom', from: str(p.from)!, to: str(p.to)! } : null,
    totals,
    groups,
    review_count: num(o.review_count),
    basis_ids: strs(o.basis_ids),
  };
}

// week 13 — receipts, statements, repeats of spendings (expenses.md «Week 13»). Lenient: unknown values fall back, money stays text.

function lineItems(v: unknown): ExpenseOut['line_items'] {
  if (!Array.isArray(v)) return null;
  return v
    .map((x) => {
      const o = obj(x);
      const name = o && str(o.name);
      return o && name ? { name, qty: str(o.qty), total: money(o.total) } : null;
    })
    .filter((x): x is NonNullable<ExpenseOut['line_items']>[number] => x !== null);
}

const DUP_STATES = new Set<string>(['suggested', 'merged', 'dismissed', 'undone']);

export function expenseDuplicateOut(v: unknown): ExpenseDuplicateOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  const keep = o && expenseOut(o.keep);
  const other = o && expenseOut(o.other);
  if (!o || !id || !keep || !other) return null;
  const status = str(o.status);
  return {
    id,
    status: (status && DUP_STATES.has(status) ? status : 'suggested') as ExpenseDuplicateOut['status'],
    keep,
    other,
    text_ru: str(o.text_ru),
    action_id: str(o.action_id),
    created_at: str(o.created_at),
    decided_at: str(o.decided_at),
  };
}

export const expenseDuplicatesOf = (v: unknown) => arr(v).map(expenseDuplicateOut).filter((x): x is ExpenseDuplicateOut => x !== null);

function receiptDraftOut(v: unknown): ReceiptDraftOut | null {
  const o = obj(v);
  if (!o) return null;
  return {
    amount: money(o.amount),
    currency: (str(o.currency) ?? 'KZT').toUpperCase(),
    spent_on: str(o.spent_on)?.slice(0, 10) ?? null,
    category_key: str(o.category_key),
    note: str(o.note),
    payee: str(o.payee),
    review_fields: strs(o.review_fields),
  };
}

const RECEIPT_STATES = new Set<string>(['ok', 'waiting', 'form', 'exists']);

export function receiptOut(v: unknown): ReceiptOut {
  const o = obj(v) ?? {};
  const status = str(o.status);
  const expense = expenseOut(o.expense);
  const retry = typeof o.retry_after === 'number' && o.retry_after > 0 ? o.retry_after : null;
  return {
    status: (status && RECEIPT_STATES.has(status) ? status : expense ? 'ok' : 'form') as ReceiptOut['status'],
    expense,
    action: actionOut(o.action),
    page_patches: arr(o.page_patches).map(pagePatchOut).filter((x): x is PagePatchOut => x !== null),
    draft: receiptDraftOut(o.draft),
    duplicate: expenseDuplicateOut(o.duplicate),
    message: str(o.message) ?? str(o.message_ru),
    retry_after: retry,
    repeated: o.repeated === true,
  };
}

const STATEMENT_STATES = new Set<string>(['proposed', 'confirmed', 'undone', 'rejected', 'expired']);

export function statementOut(v: unknown): StatementOut | null {
  const o = obj(v);
  const id = o && str(o.id);
  if (!o || !id) return null;
  const status = str(o.status);
  const period = obj(o.period);
  const check = obj(o.check);
  const adds = obj(o.adds);
  const m = (x: unknown) => money(x) ?? '0.00';
  return {
    id,
    client_id: str(o.client_id),
    item_id: str(o.item_id),
    status: (status && STATEMENT_STATES.has(status) ? status : 'proposed') as StatementStatus,
    bank: str(o.bank),
    parser: o.parser === 'template' || o.parser === 'model' ? o.parser : null,
    currency: (str(o.currency) ?? 'KZT').toUpperCase(),
    period_from: period ? str(period.from) : null,
    period_to: period ? str(period.to) : null,
    rows_found: num(o.rows_found),
    rows_new: num(o.rows_new),
    rows_existing: num(o.rows_existing),
    rows_similar: num(o.rows_similar),
    check: check
      ? {
          ok: check.ok === true,
          lines: arr(check.lines)
            .map((x) => {
              const l = obj(x);
              const key = l && str(l.key);
              return l && key ? { key, title: str(l.title) ?? key, bank: money(l.bank), ours: money(l.ours), ok: l.ok === true } : null;
            })
            .filter((x): x is NonNullable<StatementOut['check']>['lines'][number] => x !== null),
        }
      : null,
    adds: adds ? { expense: m(adds.expense), refund: m(adds.refund), income: m(adds.income), transfers: m(adds.transfers), transfer_own: m(adds.transfer_own) } : null,
    summary_ru: str(o.summary_ru),
    error: str(o.error),
    pending_action_id: str(o.pending_action_id),
    action_id: str(o.action_id),
    created_at: str(o.created_at),
    decided_at: str(o.decided_at),
  };
}

export const statementsOf = (v: unknown) => arr(v).map(statementOut).filter((x): x is StatementOut => x !== null);

const ROW_STATES = new Set<string>(['new', 'existing', 'similar']);

export function statementRowOut(v: unknown): StatementRowOut | null {
  const r = obj(v);
  const amount = r && money(r.amount);
  const date = r && str(r.date);
  if (!r || !amount || !date) return null;
  const method = str(r.method);
  const state = str(r.state);
  return {
    n: num(r.n),
    date: date.slice(0, 10),
    amount,
    currency: (str(r.currency) ?? 'KZT').toUpperCase(),
    kind: str(r.kind) ?? 'other',
    direction: typeof r.direction === 'string' && DIRECTIONS.has(r.direction) ? (r.direction as StatementRowOut['direction']) : 'expense',
    description: str(r.description),
    method: method && METHODS.has(method) ? (method as StatementRowOut['method']) : null,
    category_key: str(r.category_key),
    note: str(r.note),
    state: (state && ROW_STATES.has(state) ? state : 'new') as StatementRowOut['state'],
    existing_expense_id: str(r.existing_expense_id),
    review_fields: strs(r.review_fields),
  };
}

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
  async uploadFile(f: { clientId: string; uri: string; mime: string; bytes: number; sha256: string; role?: UploadRole }): Promise<string> {
    return (await this.uploadFull(f)).id;
  }

  /** Week 14: a logo / signature / stamp is named on PUT /company-profile by its `file_id`. */
  async uploadFileId(f: { clientId: string; uri: string; mime: string; bytes: number; sha256: string; role?: UploadRole }): Promise<string> {
    const out = await this.uploadFull(f);
    if (!out.file_id) throw new ApiError(409, { code: 'upload_mismatch' });
    return out.file_id;
  }

  private async uploadFull(f: { clientId: string; uri: string; mime: string; bytes: number; sha256: string; role?: UploadRole }): Promise<UploadOut> {
    const up = await this.createUpload({
      client_id: f.clientId,
      mime: f.mime,
      bytes: f.bytes,
      sha256: f.sha256,
      ...(f.role && f.role !== 'original' ? { role: f.role } : {}),
    });
    if (up.state === 'completed' || !up.put) return up;
    if (!this.putFile) throw new Error('putFile not configured');
    await this.putFile(f.uri, up.put);
    const done = await this.completeUpload(up.id);
    if (done.state !== 'completed') throw new ApiError(409, { code: 'upload_mismatch' });
    return done;
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
    return this.client.request('PATCH', `/pages/${encodeURIComponent(id)}`, { body, ...(body.client_id ? { idempotencyKey: body.client_id } : {}) });
  }

  /** Rename with its action («Отменить» = the old name), pages.md / views.md «Renaming». */
  async renamePage(id: string, title: string, clientId: string): Promise<PageViewOut> {
    return pageViewOut(
      await this.client.request<unknown>('PATCH', `/pages/${encodeURIComponent(id)}`, { body: { title, client_id: clientId }, idempotencyKey: clientId }),
    );
  }

  // week 11 — «Настроить страницу» S38 and `set_view` (docs/api/views.md)

  /** The catalogue: fields with ★, allowed views. */
  async pageTemplates(): Promise<PageTemplateOut[]> {
    const o = await this.client.request<unknown>('GET', '/page-templates');
    return arr(obj(o)?.templates ?? o).map(pageTemplateOut).filter((x): x is PageTemplateOut => x !== null);
  }

  /**
   * S38: view, sort, grouping, name, icon, fields, own fields, «Вернуть как было» (`reset`) — one
   * call, one action with «Отменить» (`POST /pages/{id}/view`, views.md). ★ hidden → `422
   * field_required`; a 6th own field → `422 fields_limit`.
   */
  async setView(pageId: string, body: PageViewIn): Promise<PageViewOut> {
    return pageViewOut(
      await this.client.request<unknown>('POST', `/pages/${encodeURIComponent(pageId)}/view`, { body, idempotencyKey: body.client_id }),
    );
  }

  /** A value of one field of one record on this page (a tick of a checklist, a table cell). */
  async setItemFields(pageId: string, itemId: string, body: PageItemFieldsIn): Promise<PageItemFieldsOut> {
    const o =
      obj(
        await this.client.request<unknown>('PATCH', `/pages/${encodeURIComponent(pageId)}/items/${encodeURIComponent(itemId)}`, {
          body,
          idempotencyKey: body.client_id,
        }),
      ) ?? {};
    return { values: obj(o.values) ?? {}, action: actionOut(o.action), link: linkOut(o.link) };
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

  /** S34 «Убрать»: soft delete, the records stay. Repeatable. Week 9: `action` (null on a repeat). */
  async removePage(pageId: string): Promise<{ page: PageOut | null; action: ActionOut | null }> {
    const o = await this.client.request<unknown>('DELETE', `/pages/${encodeURIComponent(pageId)}`);
    return { page: pageOutOf(o), action: actionOut(obj(o)?.action) };
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

  /** Week 9: 200 {reminder, fires, action} (was 204): any 2xx is success. */
  async deleteReminder(id: string): Promise<ReminderWithFiresOut> {
    return withFires((await this.client.request<unknown>('DELETE', `/reminders/${encodeURIComponent(id)}`)) ?? {});
  }

  /** «Перенести» (S13 on a missed one). `409 conflict` when `version` is stale. */
  async patchReminder(id: string, body: ReminderPatchIn): Promise<ReminderWithFiresOut> {
    return withFires(await this.client.request<unknown>('PATCH', `/reminders/${encodeURIComponent(id)}`, { body }));
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
    return { results, fires: firesOf(o.fires), actions: actionsOf(o.actions) };
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

  // week 9 — «Сегодня», tasks, suggestions, actions, habits (today.md, actions.md, pages.md)

  /** S06. Also runs the suggestion engine: call it when «Сегодня» is shown, not in the background. */
  async today(): Promise<TodayOut> {
    return todayOut(await this.client.request<unknown>('GET', '/today'));
  }

  async createTask(body: TaskCreateIn): Promise<TaskWriteOut> {
    return taskWrite(await this.client.request<unknown>('POST', '/tasks', { body, idempotencyKey: body.client_id }));
  }

  /** One tap = one call; `done: false` = «Вернуть». */
  async taskDone(id: string, body: TaskDoneIn): Promise<TaskWriteOut> {
    return taskWrite(
      await this.client.request<unknown>('POST', `/tasks/${encodeURIComponent(id)}/done`, { body, idempotencyKey: body.client_id }),
    );
  }

  /** «− 2 +», «На завтра» (today.md): `version` + the keys that change; `409 conflict` on a stale version. */
  async patchTask(id: string, body: TaskPatchIn): Promise<TaskWriteOut> {
    return taskWrite(await this.client.request<unknown>('PATCH', `/tasks/${encodeURIComponent(id)}`, { body }));
  }

  /** «Убрать все купленные»: one action, one «Отменить»; a repeat of `client_id` returns the first result. */
  async clearDoneTasks(body: TasksClearDoneIn): Promise<TasksClearDoneOut> {
    const o = obj(await this.client.request<unknown>('POST', '/tasks/clear-done', { body, idempotencyKey: body.client_id })) ?? {};
    return {
      tasks: arr(o.tasks).map(taskOut).filter((x): x is TaskOut => x !== null),
      action: actionOut(o.action),
      page_patches: arr(o.page_patches).map(pagePatchOut).filter((x): x is PagePatchOut => x !== null),
      repeated: o.repeated === true,
    };
  }

  /** The task and its record go to the trash. */
  async deleteTask(id: string, clientId: string): Promise<TaskWriteOut> {
    return taskWrite(
      await this.client.request<unknown>('DELETE', `/tasks/${encodeURIComponent(id)}`, {
        query: { client_id: clientId },
        idempotencyKey: clientId,
      }),
    );
  }

  async acceptSuggestion(id: string, clientId: string): Promise<SuggestionAcceptOut> {
    const o =
      obj(
        await this.client.request<unknown>('POST', `/suggestions/${encodeURIComponent(id)}/accept`, {
          body: { client_id: clientId },
          idempotencyKey: clientId,
        }),
      ) ?? {};
    return {
      suggestion: suggestionOut(o.suggestion),
      action: actionOut(o.action),
      task: taskOut(o.task),
      reminder_draft: obj(o.reminder_draft) ? parseOut(o.reminder_draft) : null,
    };
  }

  /** «Не сейчас». */
  dismissSuggestion(id: string): Promise<unknown> {
    return this.client.request('POST', `/suggestions/${encodeURIComponent(id)}/dismiss`, { body: {} });
  }

  /** S20 «Что я сделал»: newest first; `before` = an action id. */
  async actions(q: { before?: string; limit?: number } = {}): Promise<ActionsPageOut> {
    const o = obj(await this.client.request<unknown>('GET', '/actions', { query: { limit: 50, ...q } })) ?? {};
    return { actions: actionsOf(o.actions), has_more: o.has_more === true };
  }

  async habits(): Promise<HabitOut[]> {
    const o = obj(await this.client.request<unknown>('GET', '/habits')) ?? {};
    return arr(o.habits).map(habitOut).filter((x): x is HabitOut => x !== null);
  }

  /** S30 «Изменить»: the rule's records go to another page from now on. `409 conflict` (`habit_exists`). */
  async moveHabit(id: string, pageId: string, clientId: string): Promise<HabitPatchOut> {
    const o =
      obj(
        await this.client.request<unknown>('PATCH', `/habits/${encodeURIComponent(id)}`, {
          body: { page_id: pageId, client_id: clientId },
          idempotencyKey: clientId,
        }),
      ) ?? {};
    return { habit: habitOut(o.habit), action: actionOut(o.action), repeated: o.repeated === true };
  }

  /** S30 «Убрать»: the rule stops (an exclusion: the record shows on that page again). */
  async removeHabit(id: string, clientId: string): Promise<HabitRemoveOut> {
    const o =
      obj(
        await this.client.request<unknown>('DELETE', `/habits/${encodeURIComponent(id)}`, {
          query: { client_id: clientId },
          idempotencyKey: clientId,
        }),
      ) ?? {};
    return { removed: o.removed === true, repeated: o.repeated === true, action: actionOut(o.action) };
  }

  // week 10 — repeats, stacks, Telegram import (3-engineering §4.6, §4.9)

  /** GET /consents: what this account has accepted (the import needs `telegram_import`). */
  consents(): Promise<ConsentsOut> {
    return this.client.request('GET', '/consents');
  }

  /** «Объединить?» groups (`status=suggested`): near repeats, «Да» by group. */
  async duplicateGroups(status = 'suggested'): Promise<DuplicateGroupOut[]> {
    const o = await this.client.request<unknown>('GET', '/duplicates/groups', { query: { status } });
    return duplicateGroupsOf(Array.isArray(o) ? o : obj(o)?.groups);
  }

  private async decide(id: string, what: 'merge' | 'dismiss', body: DuplicateDecisionIn): Promise<DuplicateDecisionOut> {
    const o =
      obj(
        await this.client.request<unknown>('POST', `/duplicates/groups/${encodeURIComponent(id)}/${what}`, {
          body,
          idempotencyKey: body.client_id,
        }),
      ) ?? {};
    return { group: duplicateGroupOut(o.group), action: actionOut(o.action), repeated: o.repeated === true };
  }

  /** [Объединить] — this tap is the «Да» for this group. The text is joined by code (6.3 п. 4). */
  mergeGroup(id: string, body: DuplicateDecisionIn): Promise<DuplicateDecisionOut> {
    return this.decide(id, 'merge', body);
  }

  /** «Объединить все отмеченные (N)»: one action, one «Отменить»; groups closed meanwhile are skipped. */
  async mergeGroups(body: DuplicatesMergeIn): Promise<DuplicatesMergeOut> {
    const o = obj(await this.client.request<unknown>('POST', '/duplicates/merge', { body, idempotencyKey: body.client_id })) ?? {};
    return {
      groups: duplicateGroupsOf(o.groups),
      action: actionOut(o.action),
      skipped_group_ids: strs(o.skipped_group_ids),
      repeated: o.repeated === true,
    };
  }

  /** [Это разные]: the group is not offered again. */
  dismissGroup(id: string, body: DuplicateDecisionIn): Promise<DuplicateDecisionOut> {
    return this.decide(id, 'dismiss', body);
  }

  /** «Убрать повторы: 37 → 1?»: a pending action for one «Да» on all exact repeats + the near groups. */
  async cleanupPlan(body: { client_id: string; import_id?: string }): Promise<CleanupPlanOut> {
    const o =
      obj(await this.client.request<unknown>('POST', '/duplicates/cleanup/plan', { body, idempotencyKey: body.client_id })) ?? {};
    const pending = pendingActionOut(o.pending_action ?? (obj(o)?.preview ? o : null));
    return { pending_action: pending, preview: cleanupPreview(pending), groups: duplicateGroupsOf(o.near_groups ?? o.groups) };
  }

  /** «Да» of S25. Idempotent by `client_id`. `410` when it expired (24 h). */
  async confirmPending(id: string, clientId: string): Promise<PendingConfirmOut> {
    const o =
      obj(
        await this.client.request<unknown>('POST', `/pending-actions/${encodeURIComponent(id)}/confirm`, {
          body: { client_id: clientId },
          idempotencyKey: clientId,
        }),
      ) ?? {};
    return { pending_action: pendingActionOut(o.pending_action), action: actionOut(o.action) };
  }

  /** «Нет» / «Не сейчас» of S25. */
  rejectPending(id: string): Promise<unknown> {
    return this.client.request('POST', `/pending-actions/${encodeURIComponent(id)}/reject`, { body: {} });
  }

  /** Stacks; `page_id` = the ones shown as groups on that page. */
  async collections(pageId?: string): Promise<CollectionOut[]> {
    const o = await this.client.request<unknown>('GET', '/collections', pageId ? { query: { page_id: pageId } } : {});
    return collectionsOf(Array.isArray(o) ? o : obj(o)?.collections);
  }

  /** «Переименовать» (S11), with «Отменить». */
  async renameCollection(id: string, title: string, clientId: string): Promise<CollectionWriteOut> {
    return collectionWrite(
      await this.client.request<unknown>('PATCH', `/collections/${encodeURIComponent(id)}`, {
        body: { title, client_id: clientId },
        idempotencyKey: clientId,
      }),
    );
  }

  /** «Убрать из стопки»: the assistant does not put it back (a `stack_exclusion` habit). */
  async removeFromCollection(id: string, itemId: string, clientId: string): Promise<CollectionWriteOut> {
    return collectionWrite(
      await this.client.request<unknown>('DELETE', `/collections/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, {
        query: { client_id: clientId },
        idempotencyKey: clientId,
      }),
    );
  }

  /** «Разобрать стопку»: the records stay. */
  /** «Сделать стопку страницей» (founder addition): a «Своя страница» with its records, with «Отменить». */
  async collectionToPage(id: string, clientId: string): Promise<CollectionToPageOut> {
    return collectionToPageOut(
      await this.client.request<unknown>('POST', `/collections/${encodeURIComponent(id)}/to-page`, {
        body: { client_id: clientId },
        idempotencyKey: clientId,
      }),
    );
  }

  async deleteCollection(id: string, clientId: string): Promise<CollectionWriteOut> {
    return collectionWrite(
      await this.client.request<unknown>('DELETE', `/collections/${encodeURIComponent(id)}`, {
        query: { client_id: clientId },
        idempotencyKey: clientId,
      }),
    );
  }

  /** The Telegram Desktop export, uploaded through POST /uploads first. Idempotent by `client_id`. */
  async importTelegramFile(body: ImportFileIn): Promise<ImportOut> {
    const o = await this.client.request<unknown>('POST', '/imports/telegram/file', { body, idempotencyKey: body.client_id });
    const out = importOut(obj(o)?.import ?? o);
    if (!out) throw new ApiError(502, { code: 'bad_answer' });
    return out;
  }

  async getImport(id: string): Promise<ImportOut | null> {
    const o = await this.client.request<unknown>('GET', `/imports/${encodeURIComponent(id)}`);
    return importOut(obj(o)?.import ?? o);
  }

  /** [Остановить]: what came over stays (with its «Отменить»). */
  async cancelImport(id: string): Promise<ImportOut | null> {
    const o = await this.client.request<unknown>('POST', `/imports/${encodeURIComponent(id)}/cancel`, { body: {} });
    return importOut(obj(o)?.import ?? o);
  }

  // week 12 — «Расходы» (docs/api/expenses.md). Amounts are decimal strings both ways.

  async createExpense(body: ExpenseCreateIn): Promise<ExpenseWriteOut> {
    return expenseWrite(await this.client.request<unknown>('POST', '/expenses', { body, idempotencyKey: body.client_id }));
  }

  /** `409 conflict` on a stale `version`. */
  async patchExpense(id: string, body: ExpensePatchIn): Promise<ExpenseWriteOut> {
    return expenseWrite(
      await this.client.request<unknown>('PATCH', `/expenses/${encodeURIComponent(id)}`, { body, idempotencyKey: body.client_id }),
    );
  }

  /** To the trash with its record; «Отменить» brings both back. */
  async deleteExpense(id: string, clientId: string): Promise<ExpenseWriteOut> {
    return expenseWrite(
      await this.client.request<unknown>('DELETE', `/expenses/${encodeURIComponent(id)}`, {
        query: { client_id: clientId },
        idempotencyKey: clientId,
      }),
    );
  }

  async expenseCategories(): Promise<ExpenseCategoriesListOut> {
    const o = obj(await this.client.request<unknown>('GET', '/expense-categories')) ?? {};
    return { order: o.order === 'manual' ? 'manual' : 'frequency', categories: expenseCategoriesOf(o.categories) };
  }

  async reorderExpenseCategories(body: ExpenseCategoriesReorderIn): Promise<ExpenseCategoriesOut> {
    const o =
      obj(await this.client.request<unknown>('PATCH', '/expense-categories/reorder', { body, idempotencyKey: body.client_id })) ?? {};
    return { categories: expenseCategoriesOf(o.categories), action: actionOut(o.action), repeated: o.repeated === true };
  }

  /** The server's own count (`calc.py`), to check the phone's against. */
  async expenseAggregate(q: ExpenseAggregateQuery): Promise<ExpenseAggregateOut> {
    const query = Object.fromEntries(Object.entries(q).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    return expenseAggregateOut(await this.client.request<unknown>('GET', '/expenses/aggregate', { query }));
  }

  // week 13 — «Расходы 2» (expenses.md «Week 13»): receipts, fiscal QR, statements, repeats of spendings.

  /** A receipt record → its spending (amount «Проверьте»), `waiting` (OCR still running), or `form`. */
  async expenseFromItem(body: ReceiptFromItemIn): Promise<ReceiptOut> {
    return receiptOut(await this.client.request<unknown>('POST', '/expenses/from-item', { body, idempotencyKey: body.client_id }));
  }

  /** The QR link of a fiscal receipt; only official OFD domains (`422 qr_not_fiscal` otherwise). */
  async expenseFromQr(body: ReceiptFromQrIn): Promise<ReceiptOut> {
    return receiptOut(await this.client.request<unknown>('POST', '/expenses/from-qr', { body, idempotencyKey: body.client_id }));
  }

  /** A statement PDF (already a record) → the plan; nothing is saved before «Да». */
  async createStatement(body: StatementIn): Promise<StatementPlanOut> {
    const o = obj(await this.client.request<unknown>('POST', '/expenses/statements', { body, idempotencyKey: body.client_id })) ?? {};
    return { statement: statementOut(o.statement), pending_action: pendingActionOut(o.pending_action), repeated: o.repeated === true };
  }

  /** The plan with its rows (rows only while `proposed`). */
  async getStatement(id: string): Promise<StatementWithRowsOut> {
    const o = obj(await this.client.request<unknown>('GET', `/expenses/statements/${encodeURIComponent(id)}`)) ?? {};
    return { statement: statementOut(o.statement), rows: arr(o.rows).map(statementRowOut).filter((x): x is StatementRowOut => x !== null) };
  }

  /** The latest plans, newest first. */
  async statements(limit = 10): Promise<StatementOut[]> {
    const o = obj(await this.client.request<unknown>('GET', '/expenses/statements', { query: { limit: String(limit) } })) ?? {};
    return statementsOf(o.statements);
  }

  /** The one «Да» of the plan. */
  async confirmStatement(id: string, clientId: string): Promise<StatementConfirmOut> {
    const o =
      obj(
        await this.client.request<unknown>('POST', `/expenses/statements/${encodeURIComponent(id)}/confirm`, {
          body: { client_id: clientId },
          idempotencyKey: clientId,
        }),
      ) ?? {};
    return {
      statement: statementOut(o.statement),
      action: actionOut(o.action),
      created: num(o.created),
      duplicates: expenseDuplicatesOf(o.duplicates),
      repeated: o.repeated === true,
    };
  }

  /** «Не сейчас»: nothing is saved. */
  async rejectStatement(id: string): Promise<StatementOut | null> {
    const o = obj(await this.client.request<unknown>('POST', `/expenses/statements/${encodeURIComponent(id)}/reject`, { body: {} })) ?? {};
    return statementOut(o.statement);
  }

  /** «Похоже, эта трата уже есть» pairs (`suggested`). */
  async expenseDuplicates(): Promise<ExpenseDuplicateOut[]> {
    const o = obj(await this.client.request<unknown>('GET', '/expenses/duplicates', { query: { status: 'suggested', limit: '50' } })) ?? {};
    return expenseDuplicatesOf(o.duplicates);
  }

  /** [Объединить]: `keep` stays and takes what it lacks; `other` goes to the trash with its record; one «Отменить». */
  async mergeExpenseDuplicate(id: string, body: ExpenseMergeIn): Promise<ExpenseMergeOut> {
    const o =
      obj(
        await this.client.request<unknown>('POST', `/expenses/duplicates/${encodeURIComponent(id)}/merge`, { body, idempotencyKey: body.client_id }),
      ) ?? {};
    return { duplicate: expenseDuplicateOut(o.duplicate), expense: expenseOut(o.expense), action: actionOut(o.action), repeated: o.repeated === true };
  }

  /** [Это разные]: never suggested together again (no action: nothing changed). */
  async dismissExpenseDuplicate(id: string, clientId: string): Promise<ExpenseDuplicateOut | null> {
    const o =
      obj(
        await this.client.request<unknown>('POST', `/expenses/duplicates/${encodeURIComponent(id)}/dismiss`, {
          body: { client_id: clientId },
          idempotencyKey: clientId,
        }),
      ) ?? {};
    return expenseDuplicateOut(o.duplicate);
  }

  // week 14 — КП (docs/api/kp.md). Money and quantities are decimal strings both ways.

  async companyProfile(): Promise<CompanyProfileOut> {
    return companyProfileOut(await this.client.request<unknown>('GET', '/company-profile'));
  }

  /** Only the keys that changed; `409 conflict` (with `details.profile`) on a stale `base_version`. */
  async putCompanyProfile(body: CompanyProfileIn): Promise<CompanyProfileWriteOut> {
    const o = obj(await this.client.request<unknown>('PUT', '/company-profile', { body, idempotencyKey: body.client_id })) ?? {};
    return { profile: companyProfileOut(o.profile), action: actionOut(o.action), repeated: o.repeated === true };
  }

  /** «Мой прайс», 200 at a time (`next_offset` for more). */
  async priceItems(o: { q?: string; limit?: number; offset?: number } = {}): Promise<PriceSearchOut> {
    const query: Record<string, string> = { limit: String(o.limit ?? 200) };
    if (o.q) query.q = o.q;
    if (o.offset) query.offset = String(o.offset);
    const r = obj(await this.client.request<unknown>('GET', '/price-lists/items', { query })) ?? {};
    return { items: priceItemsOf(r.items), next_offset: typeof r.next_offset === 'number' ? r.next_offset : null };
  }

  /** S28 «Из прошлых КП»: prices of past КП that are not in the price list. */
  async pastPrices(limit = 50): Promise<PastPriceOut[]> {
    const o = obj(await this.client.request<unknown>('GET', '/price-lists/history', { query: { limit: String(limit) } })) ?? {};
    return arr(o.items).map(pastPriceOut).filter((x): x is PastPriceOut => x !== null);
  }

  async addPriceItems(body: PriceItemsIn): Promise<PriceItemsOut> {
    const o = obj(await this.client.request<unknown>('POST', '/price-lists/items', { body, idempotencyKey: body.client_id })) ?? {};
    return { items: priceItemsOf(o.items), action: actionOut(o.action), repeated: o.repeated === true };
  }

  async patchPriceItem(id: string, body: PriceItemPatchIn): Promise<PriceItemWriteOut> {
    const o =
      obj(await this.client.request<unknown>('PATCH', `/price-lists/items/${encodeURIComponent(id)}`, { body, idempotencyKey: body.client_id })) ?? {};
    return { item: priceItemOut(o.item), action: actionOut(o.action), repeated: o.repeated === true };
  }

  async deletePriceItem(id: string, clientId: string): Promise<PriceItemWriteOut> {
    const o =
      obj(
        await this.client.request<unknown>('DELETE', `/price-lists/items/${encodeURIComponent(id)}`, {
          query: { client_id: clientId },
          idempotencyKey: clientId,
        }),
      ) ?? {};
    return { item: null, action: actionOut(o.action), repeated: o.repeated === true };
  }

  /** The ТЗ records → `kp:extract` (202, `document.status: extracting`). Idempotent by `client_id`. */
  async createKp(body: KpCreateIn): Promise<KpFullOut> {
    return kpFullOut(await this.client.request<unknown>('POST', '/documents/kp', { body, idempotencyKey: body.client_id }));
  }

  async getDocument(id: string): Promise<KpFullOut> {
    return kpFullOut(await this.client.request<unknown>('GET', `/documents/${encodeURIComponent(id)}`));
  }

  /** The card file's КП, newest first. */
  async documents(limit = 200): Promise<DocumentOut[]> {
    const o = obj(await this.client.request<unknown>('GET', '/documents', { query: { limit: String(limit) } })) ?? {};
    return documentsOf(o.documents);
  }

  /** Tap-edits (no model): a new version; the action's «Отменить» is the revert to the one before. */
  async patchKp(id: string, body: KpPatchIn): Promise<KpFullOut> {
    return kpFullOut(await this.client.request<unknown>('POST', `/documents/${encodeURIComponent(id)}/patch`, { body, idempotencyKey: body.client_id }));
  }

  /** The step of the status strip («Клиент принял?» [Да] [Нет]). */
  async setDocumentStatus(id: string, body: DocumentStatusIn): Promise<DocumentStatusOut> {
    const o =
      obj(await this.client.request<unknown>('POST', `/documents/${encodeURIComponent(id)}/status`, { body, idempotencyKey: body.client_id })) ?? {};
    return { document: documentOut(o.document), action: actionOut(o.action), repeated: o.repeated === true };
  }

  /**
   * The PDF of the current version (the server renders; never on the phone). `422
   * kp_prices_missing` / `kp_fields_missing`, `503 kp_render_unavailable`.
   */
  async renderKp(id: string): Promise<KpRenderOut> {
    const o = obj(await this.client.request<unknown>('POST', `/documents/${encodeURIComponent(id)}/render`, { query: { format: 'pdf' } })) ?? {};
    const file = obj(o.file) ?? {};
    const url = str(file.url);
    if (!url) throw new ApiError(502, { code: 'bad_answer' });
    return { url, file_name: str(file.name) ?? 'КП.pdf', version_n: num(o.version_n), total: decText(o.total), document: documentOut(o.document) };
  }

  /** A file of the API (`/v1/…`) as an absolute URL with the session's header, for the file system's download. */
  async authedFile(path: string): Promise<{ url: string; headers: Record<string, string> }> {
    const session = await this.client.tokens.getSession();
    return { url: this.client.url(path.replace(/^\/v1(?=\/)/, '')), headers: session ? { Authorization: `Bearer ${session.accessToken}` } : {} };
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
