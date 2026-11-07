import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import type { TokenPair } from './types';

/** Secrets live in Keychain / Keystore (3-engineering §2.1). Keys: alphanumerics, `.`, `-`, `_`. */
export const KEYS = {
  deviceKey: 'auth.device_key',
  installId: 'auth.install_id',
  access: 'auth.access_token',
  accessExp: 'auth.access_expires_at',
  refresh: 'auth.refresh_token',
  /** '1': the account has a verified phone, a rejected refresh must not make a new anonymous one. */
  linked: 'auth.linked',
  /** Whose tokens these are: a different id after S04b means another account. */
  userId: 'auth.user_id',
} as const;

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// AFTER_FIRST_UNLOCK: background sync can read the refresh token while the phone is locked.
const opts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

export const secureStore: SecretStore = {
  get: (k) => SecureStore.getItemAsync(k, opts),
  set: (k, v) => SecureStore.setItemAsync(k, v, opts),
  delete: (k) => SecureStore.deleteItemAsync(k, opts),
};

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
    if (b !== undefined) out += B64URL[(n >> 6) & 63]!;
    if (c !== undefined) out += B64URL[n & 63]!;
  }
  return out;
}

export type Session = { accessToken: string; accessExpiresAt: number; refreshToken: string };

/** Token + device-key storage on top of a SecretStore (secure-store in the app, memory in tests). */
export class TokenStorage {
  private cache: Session | null | undefined;

  constructor(private readonly store: SecretStore = secureStore) {}

  /**
   * Random secret generated once per install (≥32 bytes, b64url) for POST /auth/anonymous.
   * Survives reinstall on iOS (Keychain) → same anonymous account (`created: false`).
   */
  async getOrCreateDeviceKey(): Promise<string> {
    const existing = await this.store.get(KEYS.deviceKey);
    if (existing) return existing;
    const key = base64url(Crypto.getRandomBytes(32));
    await this.store.set(KEYS.deviceKey, key);
    return key;
  }

  /** Stable `client_id` of this install for POST /devices (repeat POST = update). */
  async getOrCreateInstallId(): Promise<string> {
    const existing = await this.store.get(KEYS.installId);
    if (existing) return existing;
    const id = Crypto.randomUUID();
    await this.store.set(KEYS.installId, id);
    return id;
  }

  async getSession(): Promise<Session | null> {
    if (this.cache !== undefined) return this.cache;
    const [accessToken, exp, refreshToken] = await Promise.all([
      this.store.get(KEYS.access),
      this.store.get(KEYS.accessExp),
      this.store.get(KEYS.refresh),
    ]);
    this.cache = refreshToken
      ? { accessToken: accessToken ?? '', accessExpiresAt: Number(exp ?? 0), refreshToken }
      : null;
    return this.cache;
  }

  async saveTokens(pair: TokenPair): Promise<Session> {
    const session: Session = {
      accessToken: pair.access_token,
      accessExpiresAt: Date.parse(pair.access_expires_at) || 0,
      refreshToken: pair.refresh_token,
    };
    // Refresh first: if the app dies mid-write, the newest (rotated) refresh token is what survives.
    await this.store.set(KEYS.refresh, session.refreshToken);
    await this.store.set(KEYS.access, session.accessToken);
    await this.store.set(KEYS.accessExp, String(session.accessExpiresAt));
    if (pair.user) {
      if (pair.user.is_anonymous) await this.store.delete(KEYS.linked);
      else await this.store.set(KEYS.linked, '1');
      await this.store.set(KEYS.userId, pair.user.id);
    }
    this.cache = session;
    return session;
  }

  async isLinked(): Promise<boolean> {
    return (await this.store.get(KEYS.linked)) === '1';
  }

  async markLinked(): Promise<void> {
    await this.store.set(KEYS.linked, '1');
  }

  async getUserId(): Promise<string | null> {
    return this.store.get(KEYS.userId);
  }

  /** The account stays known (`linked`, `userId`): only the tokens go. */
  async clearSession(): Promise<void> {
    this.cache = null;
    await Promise.all([
      this.store.delete(KEYS.access),
      this.store.delete(KEYS.accessExp),
      this.store.delete(KEYS.refresh),
    ]);
  }
}

/** For tests. */
export class MemorySecretStore implements SecretStore {
  readonly data = new Map<string, string>();
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.data.set(k, v);
  }
  async delete(k: string) {
    this.data.delete(k);
  }
}
