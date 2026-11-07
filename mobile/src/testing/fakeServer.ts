import type { FetchLike } from '@/api/client';

import { jsonResponse } from './helpers';

export type Call = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
};

type Handler = (c: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | 'offline';

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

export function itemOut(clientId: string, seq: number, extra: Record<string, unknown> = {}) {
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
  };
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
