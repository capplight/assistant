import { useEffect } from 'react';
import { AppState } from 'react-native';

import { getApi, kickSync, notifyDataChanged } from '@/services';
import { useOnboarding } from '@/store/onboarding';

/** While the app is in the foreground, retry due outbox entries this often (backoff decides per entry). */
export const FOREGROUND_SYNC_INTERVAL_MS = 30_000;

/**
 * App-level sync triggers: launch, return to foreground, consent given, and a foreground timer.
 * First launch also creates the anonymous account (3-engineering §6.14) — only a technical id,
 * no content leaves the phone before S05. Failures are silent: everything stays in the outbox.
 * TODO: expo-background-task for sync while the app is closed (§2.1).
 */
export function useBackgroundSync(): void {
  const hasConsent = useOnboarding((s) => s.consent !== null);

  useEffect(() => {
    void getApi()
      .client.ensureSession()
      .catch(() => undefined);
    notifyDataChanged(); // pages table → tabs (and pages from before week 3 → pages table)
  }, []);

  useEffect(() => {
    if (!hasConsent) return;
    kickSync();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') kickSync();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') kickSync();
    }, FOREGROUND_SYNC_INTERVAL_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [hasConsent]);
}
