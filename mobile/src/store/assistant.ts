import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistStorage } from './storage';

/** A source chip: the record and the page it is on. Ids are the server's. */
export type ChatSource = {
  /** The source's id inside its reply (`s1`, `s2`…): `sources` append by it. */
  ref: string;
  itemId: string;
  pageServerId: string | null;
  pageTitle: string | null;
  title: string | null;
  /** Ready chip text from the server («Заметки · Плитка, 12 окт»), for citations. */
  label: string | null;
  occurredAt: string | null;
};

/**
 * Where an answer is:
 * - `streaming`: the stream is open;
 * - `done`: complete;
 * - `queued`: no connection, asked again when there is one («Спрошу, когда появится интернет»);
 * - `interrupted`: the stream broke before the end; what came is kept, «Спросить ещё раз»;
 * - `deferred`: the server will finish it later («Подробный ответ пришлю»);
 * - `failed`: refused (limit, error); `notice` says why.
 */
export type ChatStatus = 'streaming' | 'done' | 'queued' | 'interrupted' | 'deferred' | 'failed';

/** `offline_action` / `no_ai_action`: «Разложи» and the like need the assistant (2-design 6.9). */
/** `offline_reminder`: «Поставлю, когда появится интернет» [Поставить вручную] (US-9, Ф-1 not taken). */
export type ChatNotice =
  | 'limit'
  | 'error'
  | 'not_found'
  | 'no_ai'
  | 'offline_action'
  | 'no_ai_action'
  | 'offline_reminder'
  | null;

/** What the line thought the phrase is, for when the server can't be asked (offline, no consent yet). */
export type LineGuess = 'question' | 'action' | 'note';

/** A change the assistant made (Action of docs/api/actions.md). Item ids are the server's. */
export type ChatAction = {
  id: string;
  kind: string;
  /** `summary.ru` / `summary.kk` («Разложил 23 заметки в 5 групп»); kk falls back to ru. */
  text: string;
  textKk: string | null;
  /** The page it changed (server id), and its title as the server named it. */
  pageServerId: string | null;
  pageTitle: string | null;
  changedItemIds: string[];
  /** «Что изменилось»: ready `text` per record; `reverted` after «Вернуть». */
  changes: { itemId: string; title: string | null; text: string; reverted: boolean }[];
  createdPageId: string | null;
  undoable: boolean;
  undone?: boolean;
};

/**
 * A question back (Proposal of docs/api/chat.md): «Какую?» (`choice`), «Переставить 212 записей?»
 * (`count`), «Вы сами расставили 4 записи. Переставить и их?» (`manual`). Nothing was changed.
 */
export type ChatProposal = {
  kind: 'choice' | 'count' | 'manual';
  question: string;
  options: { id: string; label: string; kind: 'item' | 'pick' | 'yes' | 'no' | 'keep_mine' | 'cancel'; itemId: string | null }[];
  /** The option in focus first. */
  defaultId: string | null;
  /** The option tapped, or `expired` / `answered` from the server. */
  answered?: string | null;
};

/** Sent with the question: what was on screen when it was said (docs/api/chat.md). */
export type ChatAskContext = {
  visibleItemIds: string[];
  viewVersion: number | null;
  selectedItemId: string | null;
  /** A tap on an option of a question back. */
  choice?: { replyId: string; option: string } | null;
  guess?: LineGuess;
};

/** One message in the single conversation (R-52), kept on the phone for «Переписка». */
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Page id where it was said, or 'today'. Used for «— на странице X, 14:20 —» dividers. */
  pageId: string;
  pageTitle: string;
  at: string;
  /** Server message id, once known (assistant: `reply_id`). */
  serverId?: string | null;
  /** Assistant: the user message it answers. */
  replyTo?: string;
  /** Assistant: the `client_id` of this turn (the question's id; a new one after `error.retry`). */
  turnId?: string;
  /** Assistant: SSE id of the last event received, for resume (`Last-Event-ID`). */
  lastEventId?: string | null;
  /** Assistant: the server said «try again» — the next try is a new turn (new client_id). */
  newTurn?: boolean;
  status?: ChatStatus;
  /** «Сейчас: Ищу в Заметках…» while streaming. */
  activity?: string | null;
  sources?: ChatSource[];
  aiGenerated?: boolean;
  notice?: ChatNotice;
  /** Offline: records found on the phone by words (local ids). */
  localHits?: string[];
  /** Plain «Сохранил.» reply to a note (no answer to show). */
  saved?: boolean;
  /** User: the page context sent with it. */
  ask?: ChatAskContext;
  /** Assistant: `answer_kind` (`action`, `text`, `choice`, `deferred`). */
  answerKind?: string | null;
  action?: ChatAction;
  proposal?: ChatProposal;
};

/** The banner shows one message; it stays until «Закрыть» or the next request (R-52). */
export type Banner = { messageId: string };

/** Kept on the phone: enough for a long Переписка, small enough for the kv-store. */
export const MAX_LOCAL_MESSAGES = 300;

type AssistantState = {
  /** «Про: все страницы» toggle on the context chip. */
  aboutAll: boolean;
  listening: boolean;
  banner: Banner | null;
  /** «Ответ готов» on «Сегодня»: an answer finished while the phone was away (GET /chat/pending-banner). */
  pending: Banner | null;
  messages: ChatMessage[];
  setAboutAll: (v: boolean) => void;
  setListening: (v: boolean) => void;
  showBanner: (b: Banner) => void;
  closeBanner: () => void;
  setPending: (b: Banner | null) => void;
  addMessage: (m: ChatMessage) => void;
  updateMessage: (id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) => void;
  /** Server history merged in: unknown ones added, known ones completed. Sorted by time. */
  mergeMessages: (ms: ChatMessage[]) => void;
  reset: () => void;
};

const cap = (ms: ChatMessage[]) => (ms.length > MAX_LOCAL_MESSAGES ? ms.slice(ms.length - MAX_LOCAL_MESSAGES) : ms);

export const useAssistant = create<AssistantState>()(
  persist(
    (set) => ({
      aboutAll: false,
      listening: false,
      banner: null,
      pending: null,
      messages: [],
      setAboutAll: (aboutAll) => set({ aboutAll }),
      setListening: (listening) => set({ listening }),
      showBanner: (banner) => set({ banner }),
      closeBanner: () => set({ banner: null }),
      setPending: (pending) => set({ pending }),
      addMessage: (m) => set((s) => ({ messages: cap([...s.messages, m]) })),
      updateMessage: (id, patch) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)),
        })),
      mergeMessages: (incoming) =>
        set((s) => {
          const byServer = new Map(s.messages.filter((m) => m.serverId).map((m) => [m.serverId as string, m]));
          const byId = new Map(s.messages.map((m) => [m.id, m]));
          const next = [...s.messages];
          for (const m of incoming) {
            const known = (m.serverId && byServer.get(m.serverId)) || byId.get(m.id);
            if (known) {
              // A local answer the stream did not finish: the server's copy is the whole one.
              if (known.role === 'assistant' && known.status !== 'done' && m.status === 'done') {
                const i = next.indexOf(known);
                next[i] = { ...known, ...m, id: known.id, pageId: known.pageId, pageTitle: known.pageTitle };
              }
              continue;
            }
            next.push(m);
          }
          next.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
          return { messages: cap(next) };
        }),
      reset: () => set({ aboutAll: false, listening: false, banner: null, pending: null, messages: [] }),
    }),
    {
      name: 'assistant.v1',
      storage: persistStorage,
      // An open stream does not survive a restart: it shows as interrupted, with «Спросить ещё раз».
      partialize: (s) => ({
        messages: s.messages.map((m) => (m.status === 'streaming' ? { ...m, status: 'interrupted' as const, activity: null } : m)),
      }),
    },
  ),
);
