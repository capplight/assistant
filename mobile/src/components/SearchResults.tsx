import { router } from 'expo-router';
import { Search } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { LocalRecord } from '@/db/records';
import { formatShortDate, recordTitle } from '@/records/format';
import { fold, searchTerms, snippetFor } from '@/records/search';
import type { ServerResult, ServerSearchState } from '@/records/useServerSearch';
import { fetchRecord } from '@/services';
import { useToast } from '@/store/toast';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

import { AppText } from './AppText';
import { Card } from './ui/Card';
import { Icon } from './ui/Icon';
import { pressedStyle } from './ui/motion';

/** S10: the find field at the top of a page and of the results screen — tonal, no outline. */
export function FindField({
  testID,
  label,
  value,
  onChange,
}: {
  testID: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.field,
        {
          minHeight: theme.size.minTouch,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surfaceSunken,
          paddingHorizontal: theme.space[3],
          gap: theme.space[2],
        },
      ]}
    >
      <Icon icon={Search} size="sm" color="iconSecondary" />
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        placeholder={label}
        placeholderTextColor={theme.colors.ink2}
        value={value}
        onChangeText={onChange}
        returnKeyType="search"
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={[theme.type.body, styles.input, { color: theme.colors.ink, minHeight: theme.size.minTouch }]}
      />
    </View>
  );
}

/** [start, end) places of the query's words in a text (folded, so «плитка» lights «Плитку» and «ё»). */
export function matchRanges(text: string, q: string): [number, number][] {
  const hay = fold(text);
  const out: [number, number][] = [];
  for (const term of searchTerms(q)) {
    if (!term) continue;
    let at = hay.indexOf(term);
    while (at >= 0) {
      out.push([at, at + term.length]);
      at = hay.indexOf(term, at + term.length);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** The text with its matches marked (`highlightTint` + semibold): nested Text, so it wraps and scales as one. */
export function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const theme = useTheme();
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let from = 0;
  ranges.forEach(([a, b], i) => {
    const start = Math.max(a, from);
    if (b <= start || start >= text.length) return;
    if (start > from) parts.push(text.slice(from, start));
    parts.push(
      <Text key={i} style={{ backgroundColor: theme.colors.highlightTint, fontFamily: theme.type.bodyStrong.fontFamily }}>
        {text.slice(start, b)}
      </Text>,
    );
    from = b;
  });
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

/**
 * One found record as a row of its source's card: the title, the place that matched (lit), the date and the
 * «ИИ» label as given (R-06). A 52+ row with an inset divider; the last one has none.
 */
export function HitRow({
  testID,
  title,
  titleRanges,
  snippet,
  snippetRanges,
  meta,
  aiLabel,
  last,
  onPress,
}: {
  testID?: string;
  title: string;
  titleRanges: [number, number][];
  snippet: string | null;
  snippetRanges: [number, number][];
  meta: string | null;
  aiLabel: string | null;
  last: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[title, snippet, meta, aiLabel].filter(Boolean).join('. ')}
      onPress={onPress}
      style={({ pressed }) => [{ paddingLeft: theme.space[3] + 2, backgroundColor: pressed ? theme.colors.surfaceSunken : 'transparent' }, pressedStyle(pressed)]}
    >
      <View
        style={[
          { minHeight: theme.size.rowHeight, paddingVertical: theme.space[2] + 2, paddingRight: theme.space[3], gap: 2, justifyContent: 'center' },
          last ? null : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.separator },
        ]}
      >
        <AppText>
          <Highlighted text={title} ranges={titleRanges} />
        </AppText>
        {snippet ? (
          <AppText variant="callout">
            <Highlighted text={snippet} ranges={snippetRanges} />
          </AppText>
        ) : null}
        {meta || aiLabel ? <AppText variant="footnote">{[meta, aiLabel].filter(Boolean).join(' · ')}</AppText> : null}
      </View>
    </Pressable>
  );
}

/** A record found on the phone, as a row. */
export function LocalHitRow({ record, q, last, onPress }: { record: LocalRecord; q: string; last: boolean; onPress: () => void }) {
  const { t, i18n } = useTranslation();
  const title = recordTitle(record, t);
  const snippet = snippetFor(record, q);
  return (
    <HitRow
      testID={`search-rec-${record.id}`}
      title={title}
      titleRanges={matchRanges(title, q)}
      snippet={snippet}
      snippetRanges={snippet ? matchRanges(snippet, q) : []}
      meta={formatShortDate(record.occurredAt, i18n.language)}
      aiLabel={null}
      last={last}
      onPress={onPress}
    />
  );
}

/**
 * One hit from the server. On the phone already: opened at once. Not yet: the server's words (its own
 * highlights), and the record is fetched when opened. Its label is shown as given (R-06).
 */
export function ServerResultRow({ result, pageId, q, last = true }: { result: ServerResult; pageId?: string; q: string; last?: boolean }) {
  const { t, i18n } = useTranslation();
  const showToast = useToast((s) => s.show);
  const open = (id: string) => router.navigate({ pathname: '/record/[id]', params: pageId ? { id, from: pageId } : { id, q } });
  const { hit, record } = result;
  if (record) return <LocalHitRow record={record} q={q} last={last} onPress={() => open(record.id)} />;
  const title = hit.title ?? hit.snippet;
  return (
    <HitRow
      testID={`search-hit-${hit.item_id}`}
      title={title}
      titleRanges={hit.title ? matchRanges(title, q) : hit.highlights}
      snippet={hit.title ? hit.snippet : null}
      snippetRanges={hit.highlights}
      meta={hit.occurred_at ? formatShortDate(hit.occurred_at, i18n.language) : null}
      aiLabel={hit.ai_label}
      last={last}
      onPress={() => {
        void fetchRecord(hit.item_id)
          .then((rec) => {
            if (rec) open(rec.id);
            else showToast(t('search.open_failed'), 4000);
          })
          .catch(() => showToast(t('search.open_failed'), 4000));
      }}
    />
  );
}

/** A source's card: «Заметки · 3» over its rows (search results grouped by page). */
export function SourceGroup({ testID, title, count, children }: { testID?: string; title: string; count: number; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      <View style={[styles.row, { paddingHorizontal: theme.space[1], gap: theme.space[2] }]}>
        <AppText variant="sectionLabel" accessibilityRole="header" style={styles.flex}>
          {title}
        </AppText>
        <AppText variant="callout">{String(count)}</AppText>
      </View>
      <Card padded={false} style={styles.clip}>
        {children}
      </Card>
    </View>
  );
}

/** «Нашёл ещё», what the server adds, and what is going on with it. Nothing made up, nothing to explain. */
export function SearchMore({
  rows,
  state,
  pageId,
  q,
}: {
  rows: ServerResult[];
  state: ServerSearchState;
  pageId?: string;
  q: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const words = rows.filter((r) => !r.meaningOnly);
  const meaning = rows.filter((r) => r.meaningOnly);
  return (
    <View style={{ gap: theme.space[3] }}>
      {words.length > 0 ? (
        <Card padded={false} style={styles.clip}>
          {words.map((r, i) => (
            <ServerResultRow key={r.key} result={r} pageId={pageId} q={q} last={i === words.length - 1} />
          ))}
        </Card>
      ) : null}
      {meaning.length > 0 ? (
        <View style={{ gap: theme.space[2] }}>
          <AppText testID="search-more-title" variant="sectionLabel" accessibilityRole="header" style={{ paddingHorizontal: theme.space[1] }}>
            {t('search.found_more', { n: meaning.length })}
          </AppText>
          <Card padded={false} style={styles.clip}>
            {meaning.map((r, i) => (
              <ServerResultRow key={r.key} result={r} pageId={pageId} q={q} last={i === meaning.length - 1} />
            ))}
          </Card>
        </View>
      ) : null}
      <SearchState state={state} />
    </View>
  );
}

export function SearchState({ state }: { state: ServerSearchState }) {
  const { t } = useTranslation();
  if (state === 'loading')
    return (
      <AppText testID="search-looking" variant="callout">
        {t('search.looking')}
      </AppText>
    );
  if (state === 'offline')
    return (
      <AppText testID="search-offline" variant="callout" accessibilityLiveRegion="polite">
        {t('search.offline')}
      </AppText>
    );
  return null;
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  clip: { overflow: 'hidden' },
});
