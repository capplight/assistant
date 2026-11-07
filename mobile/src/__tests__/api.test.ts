import { ApiClient } from '@/api/client';
import { resolveApiBaseUrl } from '@/api/config';
import { ApiError, errorMessage, isRetryable, NetworkError , SignInRequiredError } from '@/api/errors';
import { base64url, KEYS, MemorySecretStore, TokenStorage } from '@/api/tokens';
import { FakeServer, tokenPair } from '@/testing/fakeServer';

const t = (k: string) => `t:${k}`;

function setup(server: FakeServer, now = () => Date.now()) {
  const secrets = new MemorySecretStore();
  const tokens = new TokenStorage(secrets);
  const client = new ApiClient({
    fetch: server.fetch,
    tokens,
    baseUrl: () => 'http://api.test',
    appVersion: '1.2.3',
    now,
  });
  return { secrets, tokens, client };
}

describe('config', () => {
  it('resolves base URL: env → extra → Metro LAN host:8000 → localhost', () => {
    expect(resolveApiBaseUrl({ env: 'https://api.example.kz/', hostUri: '192.168.1.5:8081' })).toBe(
      'https://api.example.kz',
    );
    expect(resolveApiBaseUrl({ extra: 'http://10.0.0.2:9000' })).toBe('http://10.0.0.2:9000');
    expect(resolveApiBaseUrl({ hostUri: '192.168.1.5:8081' })).toBe('http://192.168.1.5:8000');
    expect(resolveApiBaseUrl({})).toBe('http://127.0.0.1:8000');
  });
});

describe('auth', () => {
  it('first authed request signs in anonymously with a device key generated once', async () => {
    const s = new FakeServer()
      .on('POST /auth/anonymous', () => ({ status: 200, body: { ...tokenPair('a'), created: true } }))
      .on('GET /consents', () => ({ status: 200, body: { active: [] } }));
    const { client, secrets } = setup(s);
    await client.request('GET', '/consents');
    await client.request('GET', '/consents');

    const anon = s.callsTo('POST /auth/anonymous');
    expect(anon).toHaveLength(1);
    const key = (anon[0]?.body as { device_key: string }).device_key;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, b64url
    expect(anon[0]?.body).toMatchObject({ locale: 'ru' });
    expect(secrets.data.get(KEYS.deviceKey)).toBe(key);
    expect(secrets.data.get(KEYS.refresh)).toBe('refresh-a-xxxxxxxxxxxxxxxx');

    const authed = s.callsTo('GET /consents');
    expect(authed[1]?.headers.Authorization).toBe('Bearer access-a');
    expect(authed[1]?.headers['X-App-Version']).toBe('1.2.3');

    // Same device key after the session is gone (reinstall with Keychain → same account)
    await client.tokens.clearSession();
    await client.request('GET', '/consents');
    expect((s.callsTo('POST /auth/anonymous')[1]?.body as { device_key: string }).device_key).toBe(key);
  });

  it('401 → refresh with rotation → retry once; the new refresh token replaces the old one', async () => {
    let first = true;
    const s = new FakeServer()
      .on('POST /auth/anonymous', () => ({ status: 200, body: { ...tokenPair('a'), created: true } }))
      .on('POST /auth/refresh', () => ({ status: 200, body: tokenPair('b') }))
      .on('GET /me', (c) => {
        if (first || c.headers.Authorization !== 'Bearer access-b') {
          first = false;
          return {
            status: 401,
            body: { code: 'unauthorized', message_ru: 'Войдите снова.', message_kk: 'Қайта кіріңіз.' },
          };
        }
        return { status: 200, body: { ok: true } };
      });
    const { client, secrets } = setup(s);
    await expect(client.request('GET', '/me')).resolves.toEqual({ ok: true });
    expect(s.callsTo('POST /auth/refresh')[0]?.body).toEqual({ refresh_token: 'refresh-a-xxxxxxxxxxxxxxxx' });
    expect(secrets.data.get(KEYS.refresh)).toBe('refresh-b-xxxxxxxxxxxxxxxx');
    expect(secrets.data.get(KEYS.access)).toBe('access-b');
  });

  it('concurrent callers share a single refresh (a refresh token is used only once)', async () => {
    const s = new FakeServer()
      .on('POST /auth/refresh', () => ({ status: 200, body: tokenPair('r') }))
      .on('GET /x', () => ({ status: 200, body: 1 }));
    const { client, tokens } = setup(s);
    await tokens.saveTokens({
      ...tokenPair('old'),
      access_expires_at: new Date(Date.now() - 1000).toISOString(),
    } as never);
    await Promise.all([client.request('GET', '/x'), client.request('GET', '/x'), client.request('GET', '/x')]);
    expect(s.callsTo('POST /auth/refresh')).toHaveLength(1);
    expect(s.callsTo('GET /x').every((c) => c.headers.Authorization === 'Bearer access-r')).toBe(true);
  });

  it('expired/revoked refresh → signs in again with the same device key', async () => {
    const s = new FakeServer()
      .on('POST /auth/refresh', () => ({
        status: 401,
        body: { code: 'invalid_refresh', message_ru: 'Войдите снова.', message_kk: 'Қайта кіріңіз.' },
      }))
      .on('POST /auth/anonymous', () => ({ status: 200, body: { ...tokenPair('n'), created: false } }))
      .on('GET /x', () => ({ status: 200, body: 1 }));
    const { client, tokens } = setup(s);
    await tokens.saveTokens({ ...tokenPair('old'), access_expires_at: new Date(0).toISOString() } as never);
    await client.request('GET', '/x');
    expect(s.callsTo('POST /auth/anonymous')).toHaveLength(1);
    expect(s.callsTo('GET /x')[0]?.headers.Authorization).toBe('Bearer access-n');
  });

  const rejected = (account_linked: boolean | null) =>
    new FakeServer()
      .on('POST /auth/refresh', () => ({
        status: 401,
        body: { code: 'invalid_refresh', message_ru: '', message_kk: '', details: { account_linked } },
      }))
      .on('POST /auth/anonymous', () => ({ status: 200, body: { ...tokenPair('n'), created: false } }))
      .on('POST /auth/otp/request', () => ({ status: 200, body: { challenge_id: 'c', expires_at: 'x' } }))
      .on('GET /x', () => ({ status: 200, body: 1 }));
  const expiredPair = (is_anonymous: boolean) => {
    const pair = tokenPair('old');
    return { ...pair, access_expires_at: new Date(0).toISOString(), user: { ...pair.user, is_anonymous } } as never;
  };

  it('a linked account: asks for the phone, never makes a new anonymous account, also not at the next launch', async () => {
    const s = rejected(true);
    const { client, tokens } = setup(s);
    await tokens.saveTokens(expiredPair(false));
    await expect(client.request('GET', '/x')).rejects.toBeInstanceOf(SignInRequiredError);
    expect(await tokens.getSession()).toBeNull();
    await expect(client.ensureSession()).rejects.toBeInstanceOf(SignInRequiredError);
    await expect(client.request('GET', '/x')).rejects.toBeInstanceOf(SignInRequiredError);
    expect(s.callsTo('POST /auth/anonymous')).toHaveLength(0);
    expect(s.callsTo('GET /x')).toHaveLength(0);
  });

  it('the server does not know the token: what the phone remembers decides', async () => {
    const linked = rejected(null);
    const one = setup(linked);
    await one.tokens.saveTokens(expiredPair(false));
    await expect(one.client.request('GET', '/x')).rejects.toBeInstanceOf(SignInRequiredError);

    const anon = rejected(null);
    const two = setup(anon);
    await two.tokens.saveTokens(expiredPair(true));
    await two.client.request('GET', '/x');
    expect(anon.callsTo('POST /auth/anonymous')).toHaveLength(1);
  });

  it('the server says the account is anonymous although the phone thought otherwise: device key', async () => {
    const s = rejected(false);
    const { client, tokens } = setup(s);
    await tokens.saveTokens(expiredPair(false));
    await client.request('GET', '/x');
    expect(s.callsTo('POST /auth/anonymous')).toHaveLength(1);
  });

  it('phone sign-in after that goes with no Authorization header', async () => {
    const s = rejected(true);
    const { client, tokens } = setup(s);
    await tokens.saveTokens(expiredPair(false));
    await client.request('GET', '/x').catch(() => undefined);
    await client.requestOptionalAuth('POST', '/auth/otp/request', { body: { phone: '+77010000000' } });
    expect(s.callsTo('POST /auth/otp/request')[0]?.headers.Authorization).toBeUndefined();
  });
});

describe('errors', () => {
  it('maps the server error shape and picks the message by language', async () => {
    const s = new FakeServer().on('POST /uploads', () => ({
      status: 413,
      body: { code: 'upload_too_large', message_ru: 'Файл больше 50 МБ.', message_kk: 'Файл 50 МБ-тан үлкен.' },
    }));
    const { client } = setup(s);
    const e = await client.request('POST', '/uploads', { auth: false, body: {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    const err = e as ApiError;
    expect([err.status, err.code]).toEqual([413, 'upload_too_large']);
    expect(errorMessage(err, 'ru', t)).toBe('Файл больше 50 МБ.');
    expect(errorMessage(err, 'kk', t)).toBe('Файл 50 МБ-тан үлкен.');
    expect(isRetryable(err)).toBe(false);
  });

  it('no answer → NetworkError → offline message; 5xx/429/consent_required are retryable', async () => {
    const s = new FakeServer();
    s.offline = true;
    const { client } = setup(s);
    const e = await client.request('GET', '/consents/text', { auth: false }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NetworkError);
    expect(errorMessage(e, 'ru', t)).toBe('t:errors.offline');
    expect(isRetryable(e)).toBe(true);
    expect(isRetryable(new ApiError(503, {}))).toBe(true);
    expect(isRetryable(new ApiError(429, { retry_after: 30 }))).toBe(true);
    expect(isRetryable(new ApiError(403, { code: 'consent_required' }))).toBe(true);
    expect(errorMessage(new ApiError(500, {}), 'ru', t)).toBe('t:errors.generic');
  });

  it('Retry-After header is used when the body has none', async () => {
    const s = new FakeServer().on('GET /x', () => ({ status: 429, body: {}, headers: { 'Retry-After': '12' } }));
    const { client } = setup(s);
    const e = (await client.request('GET', '/x', { auth: false }).catch((x: unknown) => x)) as ApiError;
    expect(e.retryAfter).toBe(12);
  });
});

it('base64url encodes without padding', () => {
  expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  expect(base64url(new Uint8Array([1, 2, 3]))).toBe('AQID');
});
