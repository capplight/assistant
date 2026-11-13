import * as Crypto from 'expo-crypto';

import type { Api } from '@/api/endpoints';
import type { ConsentsIn, Locale, ServerConsentKind } from '@/api/types';

/**
 * Consent texts shown on S05. Normally fetched from GET /v1/consents/text; when the server is
 * unreachable on first launch, the app shows this bundled snapshot — byte-identical copies of the
 * server registry (`src/assistant/api/consent_texts.py`, version 2026-11-v1). The server accepts any
 * registered version, so the hash of the text the person actually saw is always provable.
 * When the lawyer's wording lands (new version), update this snapshot in the same release.
 */
/** `textHash` = sha256(utf-8 text), precomputed so S05 renders synchronously (verified by a unit test). */
type Snapshot = {
  kind: ServerConsentKind;
  version: string;
  locale: Locale;
  text: string;
  textHash: string;
  providers: string[];
};

const V = '2026-11-v1';
const AI_PROVIDERS = ['Anthropic', 'OpenAI', 'Google', 'Groq'];

export const BUNDLED_CONSENT_TEXTS: readonly Snapshot[] = [
  { kind: 'pd_processing', version: `pd-${V}`, locale: 'ru', providers: [],
    text: 'Я соглашаюсь на обработку моих записей и данных на серверах в Казахстане.',
    textHash: '4c507442bde78ed3c103d02bc83f2d20c08fb5764ed3fdb764c5db65652a9e88' },
  { kind: 'pd_processing', version: `pd-${V}`, locale: 'kk', providers: [],
    text: 'Жазбаларым мен деректерімнің Қазақстандағы серверлерде өңделуіне келісемін.',
    textHash: 'f285d797395b6fea5da713d545a533e683e5f3e6d3f8c30bb00b3316ef700d34' },
  { kind: 'ai_cross_border', version: `ai-${V}`, locale: 'ru', providers: AI_PROVIDERS,
    text: 'Я соглашаюсь, что текст, записи голоса и фото передаются для распознавания и ответов сервисам: Anthropic, OpenAI, Google, Groq. Они не обучаются на ваших данных.',
    textHash: 'a51ed0a4580eea9ffd42faba326225d4cf8b2be18db82637d5c0396ab9ee7825' },
  { kind: 'ai_cross_border', version: `ai-${V}`, locale: 'kk', providers: AI_PROVIDERS,
    text: 'Мәтін, дауыс жазбалары мен фотолар тану және жауап беру үшін мына сервистерге жіберілетініне келісемін: Anthropic, OpenAI, Google, Groq. Олар сіздің деректеріңізден үйренбейді.',
    textHash: 'c5ecebeb2abc9e1c24a65ed3fb3500d21eef7711c9031c996e7e050e20ef2513' },
  { kind: 'terms', version: `terms-${V}`, locale: 'ru', providers: [],
    text: 'Я принимаю условия использования. Мне есть 18 лет.',
    textHash: '89ca72d85012271e4c07ed60673a0b0cb45cb087c8a010042fe69ca9fe024064' },
  { kind: 'terms', version: `terms-${V}`, locale: 'kk', providers: [],
    text: 'Пайдалану шарттарын қабылдаймын. Маған 18 жас толды.',
    textHash: 'c4f43fbfc1752d9e03632e323f0a2261ca8e2b7d6fd3512dcb74628d1329ea3c' },
  { kind: 'push_content', version: `push-${V}`, locale: 'ru', providers: [],
    text: 'Текст напоминаний можно показывать в уведомлениях через Apple и Google.',
    textHash: 'fece17c2ede432216f250a0cb6e3884a283ef204f26c8576f4f5b56623e78d65' },
  { kind: 'push_content', version: `push-${V}`, locale: 'kk', providers: [],
    text: 'Еске салғыштардың мәтінін Apple және Google арқылы хабарландыруда көрсетуге болады.',
    textHash: '02dfb69ad36fa3637c6202757d1fbf6922bf26eeaf320ab833af5d8f4abb674a' },
]; // prettier-ignore

/** S05 kinds. «Согласен» (2-design S05); «Без ИИ» = everything except ai_cross_border and push_content (spec §4.2). */
export const S05_KINDS: readonly ServerConsentKind[] = ['pd_processing', 'ai_cross_border', 'terms', 'push_content'];
export const KINDS_BY_MODE: Record<'full' | 'no_ai', readonly ServerConsentKind[]> = {
  full: S05_KINDS,
  no_ai: ['pd_processing', 'terms'],
};

export type ShownConsentText = {
  kind: ServerConsentKind;
  version: string;
  locale: Locale;
  text: string;
  textHash: string;
  providers: string[];
  source: 'server' | 'bundled';
};

export type ConsentTexts = Record<(typeof S05_KINDS)[number], ShownConsentText>;

export function sha256Hex(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

export function bundledConsentTextsSync(locale: Locale): ConsentTexts {
  const out: Partial<ConsentTexts> = {};
  for (const kind of S05_KINDS) {
    const s = BUNDLED_CONSENT_TEXTS.find((t) => t.kind === kind && t.locale === locale)!;
    out[kind] = { ...s, source: 'bundled' };
  }
  return out as ConsentTexts;
}

export async function bundledConsentTexts(locale: Locale): Promise<ConsentTexts> {
  return bundledConsentTextsSync(locale);
}

/**
 * Texts for S05 in `locale`: from the server when reachable, otherwise the bundled snapshot.
 * The server hash is verified locally — if it doesn't match the text we got, we don't use it.
 */
export async function loadConsentTexts(api: Api, locale: Locale): Promise<ConsentTexts> {
  const bundled = await bundledConsentTexts(locale);
  try {
    const fetched = await Promise.all(S05_KINDS.map((k) => api.getConsentText(k, locale)));
    const out = { ...bundled };
    for (const f of fetched) {
      if ((await sha256Hex(f.text)) !== f.text_hash) continue;
      out[f.kind as keyof ConsentTexts] = {
        kind: f.kind,
        version: f.version,
        locale: f.locale,
        text: f.text,
        textHash: f.text_hash,
        providers: f.providers,
        source: 'server',
      };
    }
    return out;
  } catch {
    return bundled;
  }
}

const SCREENS: readonly ConsentsIn['screen'][] = ['S05', 'welcome', 'settings', 'import'];

/** The `screen` of `POST /v1/consents`: what the server's `consent_screen` names (features.md), or `welcome`. */
export function consentScreen(v: string | null | undefined): ConsentsIn['screen'] {
  return SCREENS.find((x) => x === v) ?? 'welcome';
}

/**
 * POST /v1/consents body for the button pressed, with the exact version + hash that was shown. `screen`: S05
 * (the old consent screen, still used for another account) or `welcome` (Ф-34: «Начать» with the policy line).
 */
export function buildConsentRequest(mode: 'full' | 'no_ai', texts: ConsentTexts, screen: ConsentsIn['screen'] = 'S05'): ConsentsIn {
  return {
    screen,
    age_confirmed_18: true, // the 18+ line is part of the `terms` text both buttons accept
    consents: KINDS_BY_MODE[mode].map((kind) => {
      const t = texts[kind as keyof ConsentTexts];
      return { kind, version: t.version, text_hash: t.textHash, locale: t.locale };
    }),
  };
}
