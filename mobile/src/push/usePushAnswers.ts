import { router } from 'expo-router';
import { useEffect } from 'react';

import { refreshExport } from '@/account/data';
import { answerFromPush, refreshPending } from '@/chat/service';
import { getPush, setPushToken } from '@/services';
import { useOnboarding } from '@/store/onboarding';

/** Week 16: «Архив готов» (`{type: "export_ready", export_id}`) opens «Мои данные». */
function exportReady(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { type?: unknown }).type === 'export_ready';
}

async function openFrom(data: unknown): Promise<void> {
  if (exportReady(data)) {
    await refreshExport();
    router.push('/my-data');
    return;
  }
  const id = await answerFromPush(data);
  if (id) router.push({ pathname: '/chat', params: { focus: id } });
}

/**
 * Push «Ответ готов» on the phone (see src/push/index.ts): the token goes with the device row once
 * notifications are allowed and the person agreed (S05); a tap opens «Переписка» on the answer; one
 * that arrives while the app is open only refreshes the card on «Сегодня».
 */
export function usePushAnswers(): void {
  const hasConsent = useOnboarding((s) => s.consent !== null);

  useEffect(() => {
    if (!hasConsent) return;
    const push = getPush();
    push.quietInForeground();
    let alive = true;
    void (async () => {
      if (await push.granted()) await setPushToken(await push.deviceToken());
      const launch = await push.lastOpened();
      if (alive && launch) await openFrom(launch);
    })().catch(() => undefined);
    const offOpen = push.onOpened((d) => void openFrom(d));
    const offReceive = push.onReceived((d) => void (exportReady(d) ? refreshExport() : refreshPending()));
    return () => {
      alive = false;
      offOpen();
      offReceive();
    };
  }, [hasConsent]);
}
