import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { FindField, LocalHitRow, SearchMore, SourceGroup } from '@/components/SearchResults';
import { NumberedSources } from '@/components/SourceChips';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Header } from '@/components/ui/Header';
import { getRecords, type LocalRecord } from '@/db';
import { placesLocally, taskItemIds } from '@/pages/contents';
import { usePageLabels } from '@/pages/usePageLabels';
import { searchRecords } from '@/records/search';
import { LIST_LIMIT, useLocalQuery } from '@/records/useRecords';
import { useServerSearch } from '@/records/useServerSearch';
import { getCapture } from '@/services';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

/** The assistant's finished answer to exactly this question, if the line asked it (sources numbered). */
function useAnswerTo(q: string): ChatMessage | null {
  const messages = useAssistant((s) => s.messages);
  return useMemo(() => {
    const asked = q.trim().toLowerCase();
    if (!asked) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== 'user' || m.text.trim().toLowerCase() !== asked) continue;
      const reply = messages.find((x) => x.role === 'assistant' && x.replyTo === m.id);
      return reply && reply.status === 'done' && reply.text.trim() && !reply.saved ? reply : null;
    }
    return null;
  }, [messages, q]);
}

/**
 * Search over all pages (F-07), from the assistant line, the page's «Искать по всем страницам» and 🔍. The
 * answer first when the line already answered this question, its sources numbered. Then what is on the phone,
 * at once and offline («Нашёл сразу: N»), grouped by the page it is on, the match lit. Then what the server
 * adds: «Нашёл ещё». Empty means «Не нашёл»; nothing is made up (F-07).
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
  const pages = usePages((s) => s.pages);
  const { title: pageTitle } = usePageLabels();

  const all = useLocalQuery(async () => (await getRecords()).list(LIST_LIMIT), []);
  const server = useServerSearch(q);
  const answer = useAnswerTo(q);
  const trimmed = q.trim();
  const found = all && trimmed ? searchRecords(all, trimmed) : [];
  const known = new Set(found.map((r) => r.serverId));
  const extra = server.results.filter((r) => !known.has(r.hit.item_id));
  const nothing = !!all && !!trimmed && found.length === 0 && extra.length === 0 && server.state !== 'loading' && !answer;
  const canSave = from === 'line' && !saved && trimmed === (asked ?? '').trim() && !!trimmed;

  const foundKey = found.map((r) => r.id).join('|');
  // Grouped by source: the first page (in the tab order) that shows the record; «Другие» for the rest.
  const groups = useMemo(() => {
    const tasks = taskItemIds();
    const out = new Map<string, { title: string; records: LocalRecord[] }>();
    for (const r of found) {
      const page = pages.find((p) => placesLocally(p, r, tasks));
      const key = page?.id ?? '';
      const g = out.get(key) ?? { title: page ? pageTitle(page) : t('search.no_page'), records: [] };
      g.records.push(r);
      out.set(key, g);
    }
    return [...out.entries()].sort(([a], [b]) => Number(a === '') - Number(b === ''));
    // `found` is new on every render; its ids say what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foundKey, pages, pageTitle, t]);

  const open = (record: LocalRecord) => router.navigate({ pathname: '/record/[id]', params: { id: record.id, q: trimmed } });

  return (
    <Screen testID="search-screen" edges={['top']}>
      <View style={{ gap: theme.space[4] }}>
        <Header
          title={t('search.title')}
          back={{ onPress: () => (router.canGoBack() ? router.back() : router.navigate('/')), testID: 'search-back' }}
        />
        <FindField testID="search-field" label={t('search.field')} value={q} onChange={setQ} />
        {answer ? (
          <Card testID="search-answer">
            <View style={{ gap: theme.space[2] }}>
              <AppText variant="sectionLabel" color="ink2">
                {t('search.answer')}
              </AppText>
              <AppText testID="search-answer-text">{answer.text}</AppText>
              {answer.aiGenerated ? (
                <AppText testID="search-answer-ai" variant="footnote">
                  {t('ai.label_short')}
                </AppText>
              ) : null}
              <NumberedSources messageId={answer.id} sources={answer.sources ?? []} />
            </View>
          </Card>
        ) : null}
        {found.length > 0 ? (
          <AppText testID="search-found" variant="sectionLabel" accessibilityRole="header" accessibilityLiveRegion="polite">
            {t('search.found', { n: found.length })}
          </AppText>
        ) : null}
        {groups.map(([key, g]) => (
          <SourceGroup key={key || 'none'} testID={`search-group-${key || 'none'}`} title={g.title} count={g.records.length}>
            {g.records.map((record, i) => (
              <LocalHitRow key={record.id} record={record} q={trimmed} last={i === g.records.length - 1} onPress={() => open(record)} />
            ))}
          </SourceGroup>
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
            style={{ alignSelf: 'flex-start' }}
            onPress={() => {
              setTyped({ ...current, saved: true });
              void getCapture()
                .then((c) => c.saveText({ text: trimmed, source: 'typed', pageId: 'today' }))
                .then(() => showToast(t('search.saved')));
            }}
          />
        ) : null}
      </View>
    </Screen>
  );
}
