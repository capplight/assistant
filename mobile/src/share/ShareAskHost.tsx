import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/Button';
import { AppText } from '@/components/AppText';
import { Sheet } from '@/components/page/ExpenseParts';
import { readAsReceipt, readAsStatement } from '@/expenses/receipts';

import { useShareAsk } from './ask';

/**
 * «Что это?» after one shared PDF or picture (S22 → «Расходы», 2-design S40 path 3): a receipt from
 * Kaspi or a shop, a bank statement (PDF only), or just a file. The file is already saved either way;
 * «Просто сохранить» (also the close button) leaves it a record like before.
 */
export function ShareAskHost() {
  const { t } = useTranslation();
  const ask = useShareAsk((s) => s.ask);
  const set = useShareAsk((s) => s.set);
  if (!ask) return null;
  const close = () => set(null);
  return (
    <Sheet testID="share-ask" title={t('exp.share_title')} onClose={close}>
      <AppText>{t('exp.share_saved')}</AppText>
      <Button
        testID="share-ask-receipt"
        label={t('exp.share_receipt')}
        onPress={() => {
          close();
          void readAsReceipt(ask.recordId, 'shared');
        }}
      />
      {ask.pdf ? (
        <Button
          testID="share-ask-statement"
          label={t('exp.share_statement')}
          variant="secondary"
          onPress={() => {
            close();
            void readAsStatement(ask.recordId).then((job) => router.push({ pathname: '/statement/[id]', params: { id: job.id } }));
          }}
        />
      ) : null}
      <Button testID="share-ask-keep" label={t('exp.share_keep')} variant="text" onPress={close} />
    </Sheet>
  );
}
