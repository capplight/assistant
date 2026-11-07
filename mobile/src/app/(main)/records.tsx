import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { RecordRow } from '@/components/RecordRow';
import { Screen } from '@/components/Screen';
import { useAllRecords } from '@/records/useRecords';
import { useTheme } from '@/theme';

/**
 * «Все записи» from «Ещё»: the shared memory itself. Pages are views, so a record no page shows
 * (the rule did not place it) is still found here (US-33, R-46).
 */
export default function AllRecordsScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const records = useAllRecords();
  return (
    <Screen testID="all-records" edges={['top']} scroll={false}>
      <FlatList
        data={records ?? []}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingVertical: theme.space[4] }}
        ListHeaderComponent={
          <AppText variant="title1" accessibilityRole="header" style={{ marginBottom: theme.space[4] }}>
            {t('more.all_records')}
          </AppText>
        }
        ListEmptyComponent={
          records ? (
            <View
              style={{
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.line,
                borderWidth: 1,
                borderRadius: theme.radius.card,
                padding: theme.space[4],
              }}
            >
              <AppText>{t('page.empty')}</AppText>
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <RecordRow
            record={item}
            onPress={() => router.navigate({ pathname: '/record/[id]', params: { id: item.id } })}
          />
        )}
      />
    </Screen>
  );
}
