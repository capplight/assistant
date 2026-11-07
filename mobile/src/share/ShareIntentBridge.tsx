import Constants, { ExecutionEnvironment } from 'expo-constants';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { getCapture } from '@/services';
import { useToast } from '@/store/toast';

import { saveSharedContent } from './handler';

/** Expo Go has no share extension — the native module is off there (needs a dev build). */
export const SHARE_INTENT_DISABLED = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** Saves whatever was shared into the app as records + outbox, then «Сохранено» (2-design §6.2). */
function ShareIntentSaver() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const show = useToast((s) => s.show);
  const { t } = useTranslation();
  const busy = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || busy.current) return;
    busy.current = true;
    void (async () => {
      try {
        const capture = await getCapture();
        const saved = await saveSharedContent(capture, shareIntent);
        if (saved.length > 0) show(t('saved'));
      } catch (e) {
        console.warn('share save failed', e);
        show(t('share.failed'), 3000);
      } finally {
        resetShareIntent();
        busy.current = false;
      }
    })();
  }, [hasShareIntent, shareIntent, resetShareIntent, show, t]);

  return null;
}

export function ShareIntentRoot({ children }: { children: ReactNode }) {
  return (
    <ShareIntentProvider options={{ disabled: SHARE_INTENT_DISABLED, resetOnBackground: true }}>
      {SHARE_INTENT_DISABLED ? null : <ShareIntentSaver />}
      {children}
    </ShareIntentProvider>
  );
}
