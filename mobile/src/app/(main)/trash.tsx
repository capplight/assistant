import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button, Card, Header } from '@/components/ui';
import { Screen } from '@/components/Screen';
import { purgeAt } from '@/db/records';
import { recordTitle, sourceLine } from '@/records/format';
import { useTrash } from '@/records/useRecords';
import { getRecordActions } from '@/services';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

const DAY_MS = 86_400_000;

/** S31 «Удалённые записи»: 30 days, one tap brings a record back (R-33). Local, so it works offline. */
export default function TrashScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const records = useTrash();
  const showToast = useToast((s) => s.show);
  const [now] = useState(() => Date.now());
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));
  return (
    <Screen testID="trash-screen" edges={['top']} scroll={false}>
      <FlatList
        data={records ?? []}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingTop: theme.space[2], paddingBottom: theme.space[4] }}
        ListHeaderComponent={<Header title={t('trash.title')} back={{ onPress: back, testID: 'trash-back' }} />}
        ListEmptyComponent={
          records ? (
            <AppText testID="trash-empty" color="ink2" style={{ textAlign: 'center', paddingVertical: theme.space[8] }}>
              {t('trash.empty')}
            </AppText>
          ) : undefined
        }
        renderItem={({ item }) => {
          const title = recordTitle(item, t);
          const days = Math.max(1, Math.ceil((purgeAt(item) - now) / DAY_MS));
          return (
            <Card testID={`trash-${item.id}`} style={{ marginBottom: theme.space[2], gap: 2 }}>
              <AppText numberOfLines={3}>{title}</AppText>
              <AppText variant="footnote">{sourceLine(item, i18n.language, t)}</AppText>
              <AppText variant="footnote">{t('trash.days_left', { n: days })}</AppText>
              <Button
                testID={`trash-restore-${item.id}`}
                label={t('trash.restore')}
                accessibilityLabel={`${t('trash.restore')}: ${title}`}
                variant="secondary"
                size="small"
                style={{ marginTop: theme.space[2], alignSelf: 'flex-start' }}
                onPress={() => {
                  showToast(t('trash.restored'));
                  void getRecordActions().then((a) => a.restore(item.id));
                }}
              />
            </Card>
          );
        }}
      />
    </Screen>
  );
}
