import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { FlatList } from 'react-native';

import { PageEmpty } from '@/components/page/PageEmpty';
import { RecordRow } from '@/components/RecordRow';
import { Screen } from '@/components/Screen';
import { Header } from '@/components/ui';
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
  // ux-audit P0-7: a stack screen has «‹ Назад».
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));
  return (
    <Screen testID="all-records" edges={['top']} scroll={false}>
      <FlatList
        data={records ?? []}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingTop: theme.space[2], paddingBottom: theme.space[4] }}
        ListHeaderComponent={<Header title={t('more.all_records')} back={{ onPress: back, testID: 'records-back' }} />}
        ListEmptyComponent={records ? <PageEmpty lines={[t('page.empty')]} /> : undefined}
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
