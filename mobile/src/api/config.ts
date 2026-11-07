import Constants from 'expo-constants';

export const DEV_API_PORT = 8000;

type Sources = {
  /** `EXPO_PUBLIC_API_URL` (from `.env` / shell), inlined at bundle time. */
  env?: string;
  /** `expo.extra.apiUrl` in app config. */
  extra?: unknown;
  /** Metro host as the phone sees it, e.g. `192.168.1.20:8081` (Expo Go / dev client). */
  hostUri?: string | null;
};

/**
 * Base URL of the backend (without `/v1`).
 * Order: EXPO_PUBLIC_API_URL → expo.extra.apiUrl → dev default `http://<LAN-IP of Metro host>:8000`
 * → `http://127.0.0.1:8000` (simulator / tests).
 */
export function resolveApiBaseUrl(src: Sources): string {
  const explicit = [src.env, typeof src.extra === 'string' ? src.extra : undefined].find((v) => v && v.trim());
  if (explicit) return explicit.trim().replace(/\/+$/, '');
  const host = src.hostUri?.split(':')[0];
  if (host) return `http://${host}:${DEV_API_PORT}`;
  return `http://127.0.0.1:${DEV_API_PORT}`;
}

export function getApiBaseUrl(): string {
  return resolveApiBaseUrl({
    env: process.env.EXPO_PUBLIC_API_URL,
    extra: Constants.expoConfig?.extra?.apiUrl,
    hostUri: Constants.expoConfig?.hostUri,
  });
}

export function getAppVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}

/** Network timeout per request (offline must be detected fast — the UI never waits for it). */
export const REQUEST_TIMEOUT_MS = 15_000;
