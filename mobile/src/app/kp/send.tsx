import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { KpSendPanel } from '@/components/kp/KpSendPanel';
import { Screen } from '@/components/Screen';
import { Header } from '@/components/ui/Header';

/**
 * S18 «КП, шаг 3: отправка» as its own screen (a link, back from WhatsApp): the same one confirmation the
 * editor opens in a sheet (`KpSendPanel`).
 */
export default function KpSendScreen() {
  const { t } = useTranslation();
  const { doc: docId } = useLocalSearchParams<{ doc: string }>();
  const close = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/kp/[id]', params: { id: docId } }));
  return (
    <Screen testID="kp-send-screen">
      <Header title={t('send.title')} back={{ onPress: close, testID: 'kp-send-close' }} />
      <KpSendPanel docId={docId} onDone={close} />
    </Screen>
  );
}
