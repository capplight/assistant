import { getApiBaseUrl, getAppVersion, REQUEST_TIMEOUT_MS } from './config';
import { ApiError, NetworkError, SignInRequiredError } from './errors';
import { TokenStorage, type Session } from './tokens';
import type { AnonymousOut, ApiErrorBody, Locale, TokenPair } from './types';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  baseUrl?: () => string;
  tokens?: TokenStorage;
  fetch?: FetchLike;
  locale?: () => Locale;
  tz?: () => string;
  appVersion?: string;
  timeoutMs?: number;
  now?: () => number;
  /** Accounts linked before the `linked` key existed. */
  isLinked?: () => boolean;
  /** A linked account lost its session: the app shows S04b. */
  onSignInRequired?: () => void;
  /** Did the last request get any answer from the server? */
  onReachable?: (reachable: boolean) => void;
};

export type RequestOptions = {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** false: no Authorization header and no session needed (auth, consent texts). */
  auth?: boolean;
  idempotencyKey?: string;
};

/** Refresh the access token this long before it expires. */
const EXPIRY_SKEW_MS = 30_000;

function deviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Almaty';
  } catch {
    return 'Asia/Almaty';
  }
}

/**
 * HTTP client for /v1: JSON, bearer access token, refresh with rotation (single-flight),
 * anonymous sign-in with the per-install device key, error bodies → ApiError, no answer → NetworkError.
 * A linked account whose refresh is rejected gets SignInRequiredError instead of a new anonymous account.
 */
export class ApiClient {
  readonly tokens: TokenStorage;
  private readonly baseUrl: () => string;
  private readonly fetchImpl: FetchLike;
  private readonly locale: () => Locale;
  private readonly tz: () => string;
  private readonly appVersion: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private refreshing: Promise<Session> | null = null;
  private readonly linkedFallback: () => boolean;
  private readonly onSignInRequired: () => void;
  private readonly onReachable: (reachable: boolean) => void;

  constructor(o: ApiClientOptions = {}) {
    this.baseUrl = o.baseUrl ?? getApiBaseUrl;
    this.tokens = o.tokens ?? new TokenStorage();
    this.fetchImpl = o.fetch ?? ((url, init) => fetch(url, init));
    this.locale = o.locale ?? (() => 'ru');
    this.tz = o.tz ?? deviceTz;
    this.appVersion = o.appVersion ?? getAppVersion();
    this.timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.now = o.now ?? Date.now;
    this.linkedFallback = o.isLinked ?? (() => false);
    this.onSignInRequired = o.onSignInRequired ?? (() => undefined);
    this.onReachable = o.onReachable ?? (() => undefined);
  }

  url(path: string, query?: RequestOptions['query']): string {
    const qs = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    return `${this.baseUrl()}/v1${path}${qs ? `?${qs}` : ''}`;
  }

  /** Raw fetch with timeout; failures without an HTTP answer become NetworkError. */
  async send(url: string, init: RequestInit): Promise<Response> {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    try {
      const res = await this.fetchImpl(url, { ...init, signal: ctrl?.signal });
      this.onReachable(true);
      return res;
    } catch (e) {
      this.onReachable(false);
      throw new NetworkError(e);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async call<T>(method: string, path: string, o: RequestOptions, accessToken?: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-App-Version': this.appVersion,
      'Accept-Language': this.locale(),
    };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
    const res = await this.send(this.url(path, o.query), {
      method,
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const body = (json && typeof json === 'object' ? json : {}) as Partial<ApiErrorBody>;
      if (body.retry_after === undefined) {
        const ra = Number(res.headers?.get?.('Retry-After'));
        if (Number.isFinite(ra) && ra > 0) body.retry_after = ra;
      }
      throw new ApiError(res.status, body);
    }
    return json as T;
  }

  /** Authenticated request: ensures a session, refreshes once on 401 and retries. */
  async request<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    if (o.auth === false) return this.call<T>(method, path, o);
    let session = await this.ensureSession();
    if (session.accessExpiresAt - EXPIRY_SKEW_MS <= this.now() || !session.accessToken) {
      session = await this.refresh();
    }
    try {
      return await this.call<T>(method, path, o, session.accessToken);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      session = await this.refresh();
      return this.call<T>(method, path, o, session.accessToken);
    }
  }

  /** With a session if there is one; signed out of a linked account: without one (phone sign-in). */
  async requestOptionalAuth<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    try {
      return await this.request<T>(method, path, o);
    } catch (e) {
      if (e instanceof SignInRequiredError) return this.call<T>(method, path, o);
      throw e;
    }
  }

  private async isLinked(): Promise<boolean> {
    return this.linkedFallback() || (await this.tokens.isLinked());
  }

  private signInRequired(): SignInRequiredError {
    this.onSignInRequired();
    return new SignInRequiredError();
  }

  /**
   * Existing session, or a new anonymous account (first launch: data in KZ right away, R-03).
   * A linked account that lost its session stays signed out until S04b.
   */
  async ensureSession(): Promise<Session> {
    const s = await this.tokens.getSession();
    if (s) return s;
    if (this.refreshing) return this.refreshing;
    if (await this.isLinked()) throw this.signInRequired();
    this.refreshing = this.signInAnonymous()
      .then(() => this.tokens.getSession() as Promise<Session>)
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  async signInAnonymous(): Promise<AnonymousOut> {
    const deviceKey = await this.tokens.getOrCreateDeviceKey();
    const out = await this.call<AnonymousOut>('POST', '/auth/anonymous', {
      body: { device_key: deviceKey, locale: this.locale(), tz: this.tz() },
    });
    await this.tokens.saveTokens(out);
    return out;
  }

  /**
   * Rotate the refresh token. Concurrent callers share one request (a second use of the same
   * refresh token would be rejected as reuse). Refresh rejected (expired/revoked): an anonymous
   * account signs in again with the device key (the server maps it to the same account); a linked
   * account has to sign in by phone. `details.account_linked` says which; when the server does not
   * know the token, what the phone remembers does. Local data stays either way.
   */
  refresh(): Promise<Session> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const current = await this.tokens.getSession();
      if (!current) {
        if (await this.isLinked()) throw this.signInRequired();
        await this.signInAnonymous();
        return (await this.tokens.getSession()) as Session;
      }
      try {
        const pair = await this.call<TokenPair>('POST', '/auth/refresh', {
          body: { refresh_token: current.refreshToken },
        });
        return await this.tokens.saveTokens(pair);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.code === 'invalid_refresh')) {
          const said = e.details?.account_linked;
          const linked = typeof said === 'boolean' ? said : await this.isLinked();
          await this.tokens.clearSession();
          if (linked) {
            await this.tokens.markLinked();
            throw this.signInRequired();
          }
          await this.signInAnonymous();
          return (await this.tokens.getSession()) as Session;
        }
        throw e;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
}
