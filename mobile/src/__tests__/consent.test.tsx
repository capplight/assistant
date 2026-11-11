import { createHash } from 'crypto';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { ApiClient } from '@/api/client';
import { Api } from '@/api/endpoints';
import { MemorySecretStore, TokenStorage } from '@/api/tokens';
import { BUNDLED_CONSENT_TEXTS, buildConsentRequest, bundledConsentTexts, loadConsentTexts } from '@/consent/texts';
import { useOnboarding } from '@/store/onboarding';
import { FakeServer, tokenPair } from '@/testing/fakeServer';
import { APP_DIR, resetApp, settle } from '@/testing/helpers';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function textServer(overrides: Partial<Record<string, { version: string; text: string; hash?: string }>> = {}) {
  return (s: FakeServer) =>
    s.on('GET /consents/text', (c) => {
      const kind = c.query.kind!;
      const locale = c.query.locale!;
      const o = overrides[kind];
      const b = BUNDLED_CONSENT_TEXTS.find((t) => t.kind === kind && t.locale === locale)!;
      const text = o?.text ?? b.text;
      return {
        status: 200,
        body: {
          kind,
          version: o?.version ?? b.version,
          locale,
          text,
          text_hash: o?.hash ?? sha(text),
          providers: b.providers,
        },
      };
    });
}

function apiFor(s: FakeServer) {
  return new Api(
    new ApiClient({
      fetch: s.fetch,
      tokens: new TokenStorage(new MemorySecretStore()),
      baseUrl: () => 'http://api.test',
    }),
  );
}

describe('consent texts', () => {
  it('bundled snapshot hashes = sha256(utf-8 text), as the server computes them', async () => {
    for (const t of BUNDLED_CONSENT_TEXTS) expect(t.textHash).toBe(sha(t.text));
    const kk = await bundledConsentTexts('kk');
    expect(kk.terms.textHash).toBe(sha('Пайдалану шарттарын қабылдаймын. Маған 18 жас толды.'));
    expect(kk.ai_cross_border.providers).toEqual(['Anthropic', 'OpenAI', 'Google', 'Groq']);
  });

  it('uses the server text/version/hash when reachable; ignores a text whose hash does not match', async () => {
    const s = new FakeServer();
    textServer({
      pd_processing: { version: 'pd-2027-01-v2', text: 'Новый текст хранения.' },
      push_content: { version: 'push-bad', text: 'x', hash: '0'.repeat(64) },
    })(s);
    const texts = await loadConsentTexts(apiFor(s), 'ru');
    expect(texts.pd_processing).toMatchObject({
      version: 'pd-2027-01-v2',
      text: 'Новый текст хранения.',
      source: 'server',
    });
    expect(texts.push_content.source).toBe('bundled');
    expect(s.calls.every((c) => !c.headers.Authorization)).toBe(true); // public endpoint
  });

  it('offline → bundled texts', async () => {
    const s = new FakeServer();
    s.offline = true;
    const texts = await loadConsentTexts(apiFor(s), 'ru');
    expect(Object.values(texts).every((t) => t.source === 'bundled')).toBe(true);
  });

  it('«Согласен» = pd + ai + terms + push; «Без ИИ» = only storage + terms; always age_confirmed_18', async () => {
    const texts = await bundledConsentTexts('ru');
    const full = buildConsentRequest('full', texts);
    expect(full.consents.map((c) => c.kind)).toEqual(['pd_processing', 'ai_cross_border', 'terms', 'push_content']);
    expect(full).toMatchObject({ screen: 'S05', age_confirmed_18: true });
    const noAi = buildConsentRequest('no_ai', texts);
    expect(noAi.consents.map((c) => c.kind)).toEqual(['pd_processing', 'terms']);
    expect(noAi.consents[1]).toEqual({
      kind: 'terms',
      version: 'terms-2026-11-v1',
      text_hash: texts.terms.textHash,
      locale: 'ru',
    });
  });
});

describe('S05 wired to the backend', () => {
  it('online: the request carries the exact version + hash of the server text that was shown', async () => {
    const s = new FakeServer();
    textServer({ terms: { version: 'terms-2027-v9', text: 'Принимаю условия. Мне есть 18 лет.' } })(s);
    const texts = await loadConsentTexts(apiFor(s), 'ru');
    expect(texts.terms.text).toBe('Принимаю условия. Мне есть 18 лет.'); // what S05 renders as the 18+ line
    const body = buildConsentRequest('full', texts);
    expect(body.consents.find((c) => c.kind === 'terms')).toEqual({
      kind: 'terms',
      version: 'terms-2027-v9',
      text_hash: sha('Принимаю условия. Мне есть 18 лет.'),
      locale: 'ru',
    });
    expect(body.consents.find((c) => c.kind === 'pd_processing')).toMatchObject({ version: 'pd-2026-11-v1' });
  });

  it('S05 online: shows the server texts and queues exactly their version + hash, then the device', async () => {
    const s = new FakeServer();
    textServer({ terms: { version: 'terms-2027-v9', text: 'Принимаю условия. Мне есть 18 лет.' } })(s);
    s.on('POST /auth/anonymous', () => ({ status: 200, body: { ...tokenPair(), created: true } }));
    const outbox = resetApp({ fetch: s.fetch });
    useOnboarding.getState().markWelcomeSeen(false);
    const r = await renderRouter(APP_DIR, { initialUrl: '/consent' });
    await settle(() => screen.queryByText('Принимаю условия. Мне есть 18 лет.') !== null);

    await fireEvent.press(screen.getByTestId('consent-storage'));
    await fireEvent.press(screen.getByTestId('consent-cross'));
    await fireEvent.press(screen.getByTestId('consent-agree'));
    await settle(() => r.getPathname() === '/start');

    const [consent, device] = outbox.all();
    expect([consent?.kind, device?.kind]).toEqual(['consent.accept', 'device.register']);
    const body = (consent?.payload as { request: { consents: { kind: string }[] } }).request;
    expect(body).toMatchObject({ screen: 'S05', age_confirmed_18: true });
    expect(body.consents.find((c) => c.kind === 'terms')).toEqual({
      kind: 'terms',
      version: 'terms-2027-v9',
      text_hash: sha('Принимаю условия. Мне есть 18 лет.'),
      locale: 'ru',
    });
  });

  it('«Без ИИ» offline: continues to S41, queues consent (storage + terms only) and the device', async () => {
    const outbox = resetApp(); // offline: S05 renders the bundled texts synchronously
    useOnboarding.getState().markWelcomeSeen(false);
    const r = await renderRouter(APP_DIR, { initialUrl: '/consent' });
    // bundled texts are on screen right away, no network needed
    expect(screen.getByTestId('consent-terms')).toHaveTextContent('Я принимаю условия использования. Мне есть 18 лет.');
    await fireEvent.press(screen.getByTestId('consent-storage'));
    await fireEvent.press(screen.getByTestId('consent-no-ai'));
    await settle(() => r.getPathname() === '/start');

    const pending = await outbox.listPending();
    expect(pending.map((e) => e.kind)).toEqual(['consent.accept', 'device.register', 'onboarding.welcome_seen']);
    const req = (pending[0]?.payload as { request: { consents: { kind: string }[] } }).request;
    expect(req.consents.map((c) => c.kind)).toEqual(['pd_processing', 'terms']);
    // the hash of exactly the text that was on screen
    expect(req.consents[1]).toMatchObject({
      version: 'terms-2026-11-v1',
      text_hash: sha('Я принимаю условия использования. Мне есть 18 лет.'),
    });
    expect(useOnboarding.getState().consent?.kinds).not.toContain('ai_cross_border');
    expect(useOnboarding.getState().consent?.kinds).not.toContain('push_content');
  });
});
