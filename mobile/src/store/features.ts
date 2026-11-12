import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { FEATURE_DEFAULTS } from '@/api/endpoints';
import type { FeaturesOut } from '@/api/types';
import { getApi } from '@/services';

import { persistStorage } from './storage';

/**
 * Beta scope switches (`GET /v1/features`, docs/api/features.md; Ф-33 «hide, don't delete»). One place for the
 * whole app: read with `useFeatures()` (or `useFeatures((f) => f.board)`), hide what is off. Fetched at start and
 * whenever the app comes to the foreground; the last answer is kept in the app's storage; with no answer yet
 * (first launch offline) the founder's decisions apply (`FEATURE_DEFAULTS`).
 */
type State = {
  features: FeaturesOut;
  /** When the last answer came (ms), null = defaults. */
  fetchedAt: number | null;
  set: (f: FeaturesOut, at?: number) => void;
  reset: () => void;
};

export const useFeatureStore = create<State>()(
  persist(
    (set) => ({
      features: FEATURE_DEFAULTS,
      fetchedAt: null,
      set: (features, at = Date.now()) => set({ features, fetchedAt: at }),
      reset: () => set({ features: FEATURE_DEFAULTS, fetchedAt: null }),
    }),
    { name: 'features.v1', storage: persistStorage, partialize: (s) => ({ features: s.features, fetchedAt: s.fetchedAt }) },
  ),
);

/** The switches, or one value of them. */
export function useFeatures(): FeaturesOut;
export function useFeatures<T>(pick: (f: FeaturesOut) => T): T;
export function useFeatures<T>(pick?: (f: FeaturesOut) => T): FeaturesOut | T {
  return useFeatureStore((s) => (pick ? pick(s.features) : s.features));
}

/** Outside React (services, the line). */
export function getFeatures(): FeaturesOut {
  return useFeatureStore.getState().features;
}

let inFlight: Promise<void> | null = null;

/** Ask the server; offline or an error keeps what we have. Never throws. */
export function refreshFeatures(): Promise<void> {
  inFlight ??= getApi()
    .features()
    .then((f) => useFeatureStore.getState().set(f))
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Root layout: fetch at start and on every return to the foreground. */
export function useFeaturesLifecycle(): void {
  useEffect(() => {
    void refreshFeatures();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refreshFeatures();
    });
    return () => sub.remove();
  }, []);
}
