import type { ApiErrorBody, Locale } from './types';

/** Server answered with an error body {code, message_ru, message_kk, retry_after?} (spec §4). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messageRu: string;
  readonly messageKk: string;
  readonly retryAfter: number | null;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, body: Partial<ApiErrorBody>) {
    super(body.code ?? `http_${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code ?? (status >= 500 ? 'internal' : `http_${status}`);
    this.messageRu = body.message_ru ?? '';
    this.messageKk = body.message_kk ?? '';
    this.retryAfter = typeof body.retry_after === 'number' ? body.retry_after : null;
    this.details = body.details ?? null;
  }
}

/** No answer from the server (offline, DNS, timeout, connection refused). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : 'network');
    this.name = 'NetworkError';
  }
}

/**
 * Worth retrying later: network, timeouts, 5xx, 429, and `consent_required`
 * (consent may still be on its way in the outbox).
 */
export function isRetryable(e: unknown): boolean {
  if (e instanceof NetworkError) return true;
  if (e instanceof ApiError) {
    return e.status >= 500 || e.status === 408 || e.status === 429 || e.code === 'consent_required';
  }
  return true; // unknown runtime failures (file read, etc.) — keep the record, try again
}

export function isOfflineError(e: unknown): boolean {
  return e instanceof NetworkError;
}

type Translate = (key: string) => string;

/**
 * Text for the UI: the server's own message in the current language (already friendly, never says
 * «ИИ»), otherwise a local fallback.
 */
export function errorMessage(e: unknown, lang: Locale, t: Translate): string {
  if (e instanceof NetworkError) return t('errors.offline');
  if (e instanceof ApiError) {
    const server = lang === 'kk' ? e.messageKk || e.messageRu : e.messageRu || e.messageKk;
    if (server) return server;
  }
  return t('errors.generic');
}
