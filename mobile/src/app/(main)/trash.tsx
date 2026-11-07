import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
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
  return (
    <Screen testID="trash-screen" edges={['top']} scroll={false}>
      <FlatList
        data={records ?? []}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingVertical: theme.space[4] }}
        ListHeaderComponent={
          <AppText variant="title1" accessibilityRole="header" style={{ marginBottom: theme.space[4] }}>
            {t('trash.title')}
          </AppText>
        }
        ListEmptyComponent={
          records ? (
            <AppText testID="trash-empty">{t('trash.empty')}</AppText>
          ) : undefined
        }
        renderItem={({ item }) => {
          const title = recordTitle(item, t);
          const days = Math.max(1, Math.ceil((purgeAt(item) - now) / DAY_MS));
          return (
            <View
              testID={`trash-${item.id}`}
              style={{
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.line,
                borderWidth: 1,
                borderRadius: theme.radius.card,
                padding: theme.space[4],
                marginBottom: theme.space[3],
                gap: theme.space[1],
              }}
            >
              <AppText numberOfLines={3}>{title}</AppText>
              <AppText variant="meta">{sourceLine(item, i18n.language, t)}</AppText>
              <AppText variant="meta">{t('trash.days_left', { n: days })}</AppText>
              <Button
                testID={`trash-restore-${item.id}`}
                label={t('trash.restore')}
                accessibilityLabel={`${t('trash.restore')}: ${title}`}
                variant="outline"
                style={{ marginTop: theme.space[2] }}
                onPress={() => {
                  showToast(t('trash.restored'));
                  void getRecordActions().then((a) => a.restore(item.id));
                }}
              />
            </View>
          );
        }}
      />
    </Screen>
  );
}
