import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { RecordRow } from '@/components/RecordRow';
import { Screen } from '@/components/Screen';
import { FindField, SearchMore } from '@/components/SearchResults';
import { getRecords } from '@/db';
import { searchRecords, snippetFor } from '@/records/search';
import { LIST_LIMIT, useLocalQuery } from '@/records/useRecords';
import { useServerSearch } from '@/records/useServerSearch';
import { getCapture } from '@/services';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

/**
 * Search over all pages (F-07), from the assistant line and from «Искать по всем страницам».
 * First what is on the phone, at once and offline: «Нашёл сразу: N». Then what the server adds:
 * «Нашёл ещё». Empty means «Не нашёл»; nothing is made up (F-07).
 * Stands in for S08 until chat (week 5) brings answers with source chips.
 */
export default function SearchScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { q: asked, from } = useLocalSearchParams<{ q?: string; from?: string }>();
  // Tabs keep this screen alive: a new question starts over.
  const [typed, setTyped] = useState({ asked, q: asked ?? '', saved: false });
  const current = typed.asked === asked ? typed : { asked, q: asked ?? '', saved: false };
  const { q, saved } = current;
  const setQ = (value: string) => setTyped({ ...current, q: value });
  const showToast = useToast((s) => s.show);

  const all = useLocalQuery(async () => (await getRecords()).list(LIST_LIMIT), []);
  const server = useServerSearch(q);
  const trimmed = q.trim();
  const found = all && trimmed ? searchRecords(all, trimmed) : [];
  const known = new Set(found.map((r) => r.serverId));
  const extra = server.results.filter((r) => !known.has(r.hit.item_id));
  const nothing = !!all && !!trimmed && found.length === 0 && extra.length === 0 && server.state !== 'loading';
  const canSave = from === 'line' && !saved && trimmed === (asked ?? '').trim() && !!trimmed;

  return (
    <Screen testID="search-screen" edges={['top']}>
      <View style={{ gap: theme.space[4], marginBottom: theme.space[4] }}>
        <AppText variant="largeTitle" accessibilityRole="header">
          {t('search.title')}
        </AppText>
        <FindField testID="search-field" label={t('search.field')} value={q} onChange={setQ} />
        {found.length > 0 ? (
          <AppText testID="search-found" variant="sectionLabel" accessibilityRole="header" accessibilityLiveRegion="polite">
            {t('search.found', { n: found.length })}
          </AppText>
        ) : null}
      </View>
      {found.map((record) => (
        <RecordRow
          key={record.id}
          record={record}
          snippet={snippetFor(record, trimmed)}
          onPress={() => router.navigate({ pathname: '/record/[id]', params: { id: record.id, q: trimmed } })}
        />
      ))}
      <SearchMore rows={extra} state={server.state} q={trimmed} />
      {nothing ? (
        <AppText testID="search-none" accessibilityLiveRegion="polite">
          {t('search.none')}
        </AppText>
      ) : null}
      {canSave ? (
        <Button
          testID="search-save"
          label={t('search.save')}
          variant="text"
          style={{ marginTop: theme.space[4] }}
          onPress={() => {
            setTyped({ ...current, saved: true });
            void getCapture()
              .then((c) => c.saveText({ text: trimmed, source: 'typed', pageId: 'today' }))
              .then(() => showToast(t('search.saved')));
          }}
        />
      ) : null}
    </Screen>
  );
}
