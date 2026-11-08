import { router } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { reminderPushFrom } from '@/api/endpoints';
import i18n from '@/i18n';
import { getAlarmPort, getPush } from '@/services';
import { useOnboarding } from '@/store/onboarding';

import { isOpen } from './plan';
import { drain, refresh, sendLabels, testTimedOut } from './service';
import { alarms } from './store';

const RECENT_MS = 30 * 60_000;

/**
 * Our S14 in the app, when the ring had no screen of ours: iOS (AlarmKit / notification) and the
 * notification fallback. Android with the module shows its own S14 over the lock screen.
 */
function openRinging(group?: string): void {
  const s = alarms();
  if (s.caps?.backend === 'android') return;
  const now = Date.now();
  const key =
    group ??
    Object.entries(s.local).find(
      ([k, l]) => l.firedAt && now - l.firedAt < RECENT_MS && !l.ackedAt && !l.snoozedUntil && s.fires[k]?.state !== 'acked',
    )?.[0];
  const fire = key ? s.fires[key] : undefined;
  if (!key || !fire || !isOpen(fire, s.reminders[fire.reminder_id], s.local[key])) return;
  router.push({ pathname: '/alarm', params: { group: key } });
}

/**
 * Reminders on this phone (root layout): plan at start and on every return to the foreground,
 * read rings and taps from the module, react to the server's backup push, send the native screens
 * their texts in the person's language. Works before consent too (local reminders ring); the server
 * part waits for S05.
 */
export function useAlarmsLifecycle(): void {
  const language = useOnboarding((s) => s.language);
  const hasConsent = useOnboarding((s) => s.consent !== null);

  useEffect(() => {
    sendLabels();
  }, [language]);

  useEffect(() => {
    void refresh().then(() => openRinging());
    const port = getAlarmPort();
    const off = port.onEvent(() => {
      void drain().then((events) => {
        const tap = events.find((e) => e.event === 'shown' && e.surface === 'notification');
        if (tap) openRinging(tap.group);
      });
    });
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh().then(() => openRinging());
    });
    const timer = setInterval(() => {
      if (testTimedOut()) void refresh();
    }, 30_000);
    const push = getPush();
    const offPush = push.onReceived((d) => {
      if (reminderPushFrom(d)) void refresh();
    });
    const offOpen = push.onOpened((d) => {
      const r = reminderPushFrom(d);
      if (!r) return;
      void refresh().then(() => {
        const key = Object.values(alarms().fires).find((f) => f.id === r.fire_id)?.key;
        if (key) openRinging(key);
      });
    });
    return () => {
      off();
      sub.remove();
      clearInterval(timer);
      offPush();
      offOpen();
    };
  }, [hasConsent]);

  useEffect(() => {
    i18n.on('languageChanged', sendLabels);
    return () => i18n.off('languageChanged', sendLabels);
  }, []);
}
