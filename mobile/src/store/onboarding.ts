import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { detectDeviceLanguage, setLanguage, type Language } from '@/i18n';
import type { TemplateKey } from '@/pages/templates';

import { persistStorage } from './storage';

/** Welcome frame 2 rows (2-design S02). Tapping one is a soft pick, not a questionnaire. */
export type TourInterest = 'voice' | 'photo' | 'find' | 'kp' | 'money';
export const TOUR_INTERESTS: TourInterest[] = ['voice', 'photo', 'find', 'kp', 'money'];

/** Which gallery cards a welcome pick premarks in S35. */
const INTEREST_TEMPLATES: Record<TourInterest, TemplateKey[]> = {
  voice: ['tasks'],
  photo: ['expenses'],
  find: ['notes'],
  kp: ['documents'],
  money: ['expenses'],
};

export function premarksFor(interests: TourInterest[], base: readonly TemplateKey[]): TemplateKey[] {
  const out = new Set<TemplateKey>(base);
  for (const i of interests) for (const k of INTEREST_TEMPLATES[i]) out.add(k);
  return [...out];
}

/** 3-engineering §3.11: onboarding_path. */
export type OnboardingPath = 'gallery' | 'blank' | 'phrase_first' | 'skipped';

/**
 * Consent kinds from S05 (3-engineering §3.2). «Согласен» records all five;
 * «Без ИИ» records everything except `ai_cross_border` (R-05).
 */
export type ConsentKind = 'pd_processing' | 'ai_cross_border' | 'terms' | 'age_confirmed_18' | 'push_content';

/** What exactly was shown and accepted for one server kind (proof: version + sha256 of the text). */
export type AcceptedText = { kind: string; version: string; textHash: string; locale: string };

export type ConsentRecord = {
  mode: 'full' | 'no_ai';
  kinds: ConsentKind[];
  /** Version of the first accepted text (kept for compatibility); details in `texts`. */
  textVersion: string;
  texts: AcceptedText[];
  acceptedAt: string;
  /** Not yet confirmed by the backend — sent via the outbox (`consent.accept`). */
  synced: boolean;
};

export const CONSENT_TEXT_VERSION_DRAFT = 'draft-2026-11-05';

type OnboardingState = {
  language: Language;
  welcomeSeenAt: string | null;
  /** Soft picks from welcome frame 2 (e.g. «Сделать КП» → documents premarked in S35). */
  interests: TourInterest[];
  consent: ConsentRecord | null;
  path: OnboardingPath | null;
  doneAt: string | null;
  setLanguage: (lang: Language) => void;
  toggleInterest: (key: TourInterest) => void;
  markWelcomeSeen: (skipped: boolean) => void;
  acceptConsent: (mode: ConsentRecord['mode'], texts?: AcceptedText[]) => void;
  setPath: (path: OnboardingPath) => void;
  complete: () => void;
  reset: () => void;
};

const initial = {
  language: detectDeviceLanguage(),
  welcomeSeenAt: null,
  interests: [] as TourInterest[],
  consent: null,
  path: null,
  doneAt: null,
};

export const useOnboarding = create<OnboardingState>()(
  persist(
    (set) => ({
      ...initial,
      setLanguage: (language) => {
        setLanguage(language);
        set({ language });
      },
      toggleInterest: (key) =>
        set((s) => ({
          interests: s.interests.includes(key) ? s.interests.filter((k) => k !== key) : [...s.interests, key],
        })),
      markWelcomeSeen: (skipped) =>
        set((s) => ({ welcomeSeenAt: new Date().toISOString(), path: skipped ? 'skipped' : s.path })),
      acceptConsent: (mode, texts = []) =>
        set({
          consent: {
            mode,
            // «Без ИИ»: everything except ai_cross_border and push_content (3-engineering §4.2).
            kinds:
              mode === 'full'
                ? ['pd_processing', 'ai_cross_border', 'terms', 'age_confirmed_18', 'push_content']
                : ['pd_processing', 'terms', 'age_confirmed_18'],
            textVersion: texts[0]?.version ?? CONSENT_TEXT_VERSION_DRAFT,
            texts,
            acceptedAt: new Date().toISOString(),
            synced: false,
          },
        }),
      setPath: (path) => set({ path }),
      complete: () => set({ doneAt: new Date().toISOString() }),
      reset: () => set({ ...initial }),
    }),
    {
      name: 'onboarding.v1',
      storage: persistStorage,
      partialize: ({ language, welcomeSeenAt, interests, consent, path, doneAt }) => ({
        language,
        welcomeSeenAt,
        interests,
        consent,
        path,
        doneAt,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) setLanguage(state.language);
      },
    },
  ),
);

/** True when the user chose «Без ИИ»: no voice, no AI calls, text-only. */
export const selectNoAi = (s: OnboardingState) => s.consent?.mode === 'no_ai';
