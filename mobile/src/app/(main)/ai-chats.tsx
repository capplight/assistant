import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AppText } from '@/components/AppText';
import { PageEmpty } from '@/components/page/PageEmpty';
import { RecordRow } from '@/components/RecordRow';
import { Screen } from '@/components/Screen';
import { PlaceFlatList } from '@/components/ui/PlaceScreen';
import { FindField } from '@/components/SearchResults';
import { Button } from '@/components/ui/Button';
import { Header } from '@/components/ui/Header';
import { searchRecords } from '@/records/search';
import { useAllRecords } from '@/records/useRecords';
import { useTheme } from '@/theme';

/**
 * «Чаты ИИ» (Ф-77): the conversations brought from ChatGPT, Claude or Gemini («Принести переписку») — kept apart
 * from «Заметки». Newest first, each with its «из ChatGPT» chip; the field finds them by words on this phone (the
 * assistant finds them by meaning too). Empty: what to do to bring them.
 */
export default function AiChatsScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const records = useAllRecords();
  const [q, setQ] = useState('');
  const chats = useMemo(() => (records ?? []).filter((r) => r.kind === 'ai_chat'), [records]);
  const shown = useMemo(() => (q.trim() ? searchRecords(chats, q, 200) : chats), [chats, q]);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));
  return (
    <Screen
      testID="page-ai-chats"
      scroll={false}
      sub={records ? t('aichats.count', { count: chats.length }) : undefined}
      // screens-v5 «Переписки с ChatGPT»: «Принести ещё архив» — an outlined button at the bottom (it was in «Ещё»).
      footer={chats.length > 0 ? <Button testID="aichats-bring-more" label={t('aichats.bring_more')} variant="secondary" onPress={() => router.push('/ai-import')} /> : undefined}
    >
      <Header title={t('aichats.title')} back={{ onPress: back, label: t('more.title'), testID: 'aichats-back' }} />
      <PlaceFlatList
        data={shown}
        keyExtractor={(r) => r.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: theme.space[2], paddingBottom: theme.size.contentEndGap }}
        ListHeaderComponent={
          <View style={{ gap: theme.space[2], marginBottom: theme.space[2] }}>
            {chats.length > 0 ? <FindField testID="aichats-find" label={t('aichats.find')} value={q} onChange={setQ} /> : null}
          </View>
        }
        ListEmptyComponent={
          records ? (
            chats.length === 0 ? (
              <View testID="aichats-empty" style={{ gap: theme.space[3] }}>
                <PageEmpty lines={[t('aichats.empty')]} />
                <Button testID="aichats-import" label={t('aichats.bring')} onPress={() => router.push('/ai-import')} />
              </View>
            ) : (
              <AppText testID="aichats-none" color="ink2">
                {t('aichats.none')}
              </AppText>
            )
          ) : undefined
        }
        renderItem={({ item }) => (
          <RecordRow record={item} snippet={q.trim() ? item.text?.slice(0, 160) : undefined} onPress={() => router.navigate({ pathname: '/record/[id]', params: { id: item.id } })} />
        )}
      />
    </Screen>
  );
}
