import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PageEmpty } from '@/components/page/PageEmpty';
import { RecordRow } from '@/components/RecordRow';
import { Screen } from '@/components/Screen';
import { ChipRow } from '@/components/ui/Leaf';
import { PlaceFlatList } from '@/components/ui/PlaceScreen';
import { Chip, Header } from '@/components/ui';
import { useAllRecords } from '@/records/useRecords';
import { useTheme } from '@/theme';

/**
 * «Все записи» from «Ещё»: the shared memory itself. Pages are views, so a record no page shows
 * (the rule did not place it) is still found here (US-33, R-46).
 */
type Kind = 'all' | 'voice' | 'photo' | 'files';
const KINDS: Kind[] = ['all', 'voice', 'photo', 'files'];
const KIND_SOURCES: Record<Exclude<Kind, 'all'>, string[]> = { voice: ['mic'], photo: ['camera'], files: ['files', 'share'] };

export default function AllRecordsScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const records = useAllRecords();
  // screens-v5-extra «Все записи»: chips by where it came from (voice, photo, files).
  const [kind, setKind] = useState<Kind>('all');
  const shown = (records ?? []).filter((r) => kind === 'all' || KIND_SOURCES[kind].includes(r.source));
  // ux-audit P0-7: a stack screen has «‹ Назад».
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));
  return (
    <Screen testID="all-records" scroll={false} sub={records ? t('more.records_count', { count: records.length }) : undefined}>
      <Header title={t('more.all_records')} back={{ onPress: back, label: t('more.title'), testID: 'records-back' }} />
      <PlaceFlatList
        data={shown}
        ListHeaderComponent={
          <ChipRow testID="records-kinds" style={{ marginBottom: theme.space[3] }}>
            {KINDS.map((k) => (
              <Chip key={k} testID={`records-kind-${k}`} label={t(`records.kind_${k}`)} variant={kind === k ? 'selected' : 'neutral'} selected={kind === k} onPress={() => setKind(k)} />
            ))}
          </ChipRow>
        }
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingTop: theme.space[2], paddingBottom: theme.space[4] }}
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
