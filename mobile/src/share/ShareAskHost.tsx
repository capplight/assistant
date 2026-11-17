import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/Button';
import { AppText } from '@/components/AppText';
import { Sheet } from '@/components/ui/Sheet';
import { readAsReceipt, readAsStatement } from '@/expenses/receipts';
import { makeDocumentFrom } from '@/kp/start';
import { useFeatures } from '@/store/features';

import { useShareAsk } from './ask';

/**
 * «Что это?» after one shared PDF or picture (S22 → «Расходы», 2-design S40 path 3): a receipt from
 * Kaspi or a shop, a bank statement (PDF only, only while `statements_pdf` is on — Ф-37), «Сделать документ из
 * этого» (a КП from the client's file, Ф-51), or just a file. The file is already saved either way;
 * «Просто сохранить» (also the close button) leaves it a record like before.
 */
export function ShareAskHost() {
  const { t } = useTranslation();
  const ask = useShareAsk((s) => s.ask);
  const set = useShareAsk((s) => s.set);
  const statements = useFeatures((f) => f.statements_pdf);
  if (!ask) return null;
  const close = () => set(null);
  return (
    // screens-v5-extra «Что это?»: what was shared is the assistant's — the sheet carries its terracotta strip.
    <Sheet visible testID="share-ask" title={t('exp.share_title')} onClose={close} place="assistant">
      <AppText>{t('exp.share_saved')}</AppText>
      <Button
        testID="share-ask-receipt"
        label={t('exp.share_receipt')}
        onPress={() => {
          close();
          void readAsReceipt(ask.recordId, 'shared');
        }}
      />
      {ask.pdf && statements ? (
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
      <Button
        testID="share-ask-document"
        label={t('kp.make_from_file')}
        variant="secondary"
        onPress={() => {
          close();
          makeDocumentFrom(ask.recordId);
        }}
      />
      <Button testID="share-ask-keep" label={t('exp.share_keep')} variant="text" onPress={close} />
    </Sheet>
  );
}
