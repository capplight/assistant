import type { FetchLike } from '@/api/client';
import type { ItemOut, PageItemOut, PageOut } from '@/api/types';

import { jsonResponse } from './helpers';

export type Call = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
};

/** One SSE event of a fake stream; `data` is sent as JSON. */
export type SseEvent = { event: string; data: unknown; id?: number };

type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** text/event-stream: these events, one chunk each (split in two, to test framing). */
  sse?: SseEvent[];
  /** After the events: `end` closes without a final event; `error` breaks the read. */
  drop?: 'end' | 'error';
  /** Fake (or real) ms between chunks: the UI can be seen mid-stream. */
  chunkDelayMs?: number;
};

type Handler = (c: Call) => Reply | 'offline';

/** A streaming Response with `body.getReader()` like expo/fetch's. */
export function sseResponse(events: SseEvent[], o: { drop?: 'end' | 'error'; chunkDelayMs?: number } = {}): Response {
  const chunks: string[] = [];
  for (const e of events) {
    const idLine = e.id !== undefined ? `id: ${e.id}\n` : '';
    const text = `${idLine}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
    const half = Math.ceil(text.length / 2);
    chunks.push(text.slice(0, half), text.slice(half));
  }
  chunks.push(': keep-alive\n\n');
  const enc = new TextEncoder();
  let i = 0;
  const reader = {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      if (o.chunkDelayMs) await new Promise((r) => setTimeout(r, o.chunkDelayMs));
      if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) };
      if (o.drop === 'error') throw new TypeError('Network connection was lost');
      return { done: true };
    },
    cancel: async () => undefined,
  };
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: { getReader: () => reader },
    text: async () => chunks.join(''),
  } as unknown as Response;
}

/** Minimal in-test HTTP server: route by "METHOD /path" (path after /v1), records every call. */
export class FakeServer {
  readonly calls: Call[] = [];
  private routes = new Map<string, Handler>();
  offline = false;

  on(route: string, h: Handler): this {
    this.routes.set(route, h);
    return this;
  }

  callsTo(route: string): Call[] {
    const [m, p] = route.split(' ');
    return this.calls.filter((c) => c.method === m && c.path === p);
  }

  readonly fetch: FetchLike = async (url, init) => {
    if (this.offline) throw new TypeError('Network request failed');
    const [base, qs = ''] = url.split('?');
    const path = (base ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/v1/, '');
    const query: Record<string, string> = {};
    for (const part of qs.split('&').filter(Boolean)) {
      const [k = '', v = ''] = part.split('=');
      query[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    const call: Call = {
      method: (init.method ?? 'GET').toUpperCase(),
      path,
      query,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    };
    this.calls.push(call);
    const h =
      this.routes.get(`${call.method} ${path}`) ??
      [...this.routes.entries()].find(([k]) => {
        const [m, p] = k.split(' ');
        return m === call.method && p?.includes('*') && new RegExp(`^${p.replace(/\*/g, '[^/]+')}$`).test(path);
      })?.[1];
    if (!h) return jsonResponse(404, { code: 'not_found', message_ru: 'Не найдено.', message_kk: 'Табылмады.' });
    const r = h(call);
    if (r === 'offline') throw new TypeError('Network request failed');
    if (r.sse) return sseResponse(r.sse, { drop: r.drop, chunkDelayMs: r.chunkDelayMs });
    return jsonResponse(r.status, r.body, r.headers);
  };
}

let n = 0;
export function tokenPair(tag = String(++n)) {
  return {
    token_type: 'Bearer',
    access_token: `access-${tag}`,
    access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    refresh_token: `refresh-${tag}-xxxxxxxxxxxxxxxx`,
    refresh_expires_at: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    user: {
      id: 'u-1',
      display_name: null,
      locale: 'ru',
      tz: 'Asia/Almaty',
      country: null,
      is_anonymous: true,
      age_confirmed: false,
    },
  };
}

export function itemOut(clientId: string, seq: number, extra: Record<string, unknown> = {}): ItemOut {
  return {
    id: `srv-${clientId}`,
    client_id: clientId,
    kind: 'note',
    source: 'typed',
    status: 'pending',
    title: null,
    text: null,
    occurred_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    seq,
    ...extra,
  } as ItemOut;
}

export function pageOut(clientId: string | null, seq: number, extra: Record<string, unknown> = {}): PageOut {
  return {
    id: `srv-${clientId ?? seq}`,
    client_id: clientId,
    kind: 'page',
    template_key: 'custom',
    template_version: 1,
    title: 'Моя страница',
    title_kk: null,
    icon: 'other',
    position: 'V',
    layout: 'list',
    view_state: {},
    field_prefs: [],
    custom_fields: [],
    customized: false,
    view_version: 1,
    created_by: 'user',
    hidden_at: null,
    last_opened_at: null,
    seq,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
    ...extra,
  } as PageOut;
}

export function linkOut(pageId: string, itemId: string, seq: number, extra: Record<string, unknown> = {}): PageItemOut {
  return {
    id: `link-${pageId}-${itemId}`,
    page_id: pageId,
    item_id: itemId,
    position: 'V',
    group_key: null,
    manual_order: false,
    manual_at: null,
    pinned: false,
    added_by: 'rule',
    removed_at: null,
    seq,
    updated_at: new Date().toISOString(),
    updated_by: 'agent',
    ...extra,
  } as PageItemOut;
}

/** POST /v1/items response shape (server ItemCreateOut). */
export function createOut(item: unknown, created = true) {
  return { item, created, auto_merged: false, duplicate: null };
}

/** A server that accepts everything: auth, consents, devices, uploads, items (idempotent), sync. */
export function happyServer(): FakeServer {
  const s = new FakeServer();
  const items = new Map<string, ReturnType<typeof itemOut>>();
  let seq = 0;
  /** The id in /items/{id}... is the server id `srv-<client id>`. */
  const serverItem = (path: string, s: number, extra: Record<string, unknown>) => {
    const clientId = (path.split('/')[2] ?? '').replace(/^srv-/, '');
    return { ...(items.get(clientId) ?? itemOut(clientId, s)), seq: s, ...extra };
  };
  s.on('POST /auth/anonymous', () => ({ status: 200, body: { ...tokenPair(), created: true } }))
    .on('POST /auth/refresh', () => ({ status: 200, body: tokenPair() }))
    .on('POST /consents', () => ({
      status: 200,
      body: { active: [], history: [], ai_enabled: true, app_enabled: true },
    }))
    .on('POST /devices', (c) => ({
      status: 200,
      body: {
        id: 'd-1',
        client_id: (c.body as { client_id: string }).client_id,
        platform: 'ios',
        app_version: null,
        push_provider: null,
        has_push_token: false,
        capabilities: {},
        last_active_at: null,
      },
    }))
    .on('POST /uploads', (c) => ({
      status: 200,
      body: {
        id: `up-${(c.body as { client_id: string }).client_id}`,
        state: 'pending',
        put: {
          url: 'http://s3.test/put',
          method: 'PUT',
          headers: { 'Content-Type': 'audio/mp4' },
          expires_at: new Date().toISOString(),
        },
        file_id: null,
      },
    }))
    .on('POST /uploads/*/complete', (c) => ({
      status: 200,
      body: { id: c.path.split('/')[2], state: 'completed', put: null, file_id: 'f-1' },
    }))
    .on('POST /items', (c) => {
      const b = c.body as { client_id: string; kind: string; source: string; text?: string };
      const existing = items.get(b.client_id);
      if (existing) return { status: 200, body: createOut(existing, false) };
      const it = itemOut(b.client_id, ++seq, { kind: b.kind ?? 'file_other', source: b.source, text: b.text ?? null });
      items.set(b.client_id, it);
      return { status: 201, body: createOut(it, true) };
    })
    .on('POST /pages', (c) => {
      const b = c.body as { client_id: string; template_key: string; title?: string };
      return {
        status: 201,
        body: { page: pageOut(b.client_id, ++seq, { template_key: b.template_key, title: b.title ?? 'Моя страница' }), created: true },
      };
    })
    .on('PATCH /pages/*', (c) => ({
      status: 200,
      body: pageOut(null, ++seq, { id: c.path.split('/')[2], ...(c.body as object) }),
    }))
    .on('POST /pages/*/items', (c) => ({
      status: 201,
      body: { link: linkOut(c.path.split('/')[2] ?? '', (c.body as { item_id: string }).item_id, ++seq), created: true },
    }))
    .on('PATCH /me', (c) => ({ status: 200, body: { ...tokenPair().user, ...(c.body as object) } }))
    .on('DELETE /items/*', (c) => ({
      status: 200,
      body: serverItem(c.path, ++seq, { deleted_at: new Date().toISOString(), purge_after: new Date(Date.now() + 30 * 86_400_000).toISOString() }),
    }))
    .on('POST /items/*/restore', (c) => ({
      status: 200,
      body: serverItem(c.path, ++seq, { deleted_at: null, purge_after: null }),
    }))
    .on('GET /search', () => ({ status: 200, body: { results: [], semantic: true } }))
    .on('GET /chat/messages', () => ({ status: 200, body: { messages: [], has_more_before: false, has_more_after: false } }))
    .on('POST /chat/messages/*/delivery', () => ({ status: 200, body: {} }))
    .on('GET /chat/pending-banner', () => ({ status: 200, body: { message: null } }))
    .on('POST /feedback', () => ({ status: 201, body: { id: 'fb-1', created_at: new Date().toISOString() } }))
    .on('GET /sync', (c) => {
      const since = Number(c.query.since ?? 0);
      const list = [...items.values()].filter((i) => i.seq > since);
      return {
        status: 200,
        body: { items: list, tombstones: [], next_since: Math.max(since, ...list.map((i) => i.seq)), has_more: false },
      };
    });
  return s;
}
