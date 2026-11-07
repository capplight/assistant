import { router } from 'expo-router';
import { Search } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { ServerResult, ServerSearchState } from '@/records/useServerSearch';
import { fetchRecord } from '@/services';
import { useToast } from '@/store/toast';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

import { AppText } from './AppText';
import { RecordRow } from './RecordRow';

/** S10: a 56 pt field at the top of the page; also the field of the results screen. */
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
          minHeight: theme.size.primaryTouch,
          borderColor: theme.colors.lineStrong,
          borderRadius: theme.radius.input,
          backgroundColor: theme.colors.surface,
          paddingHorizontal: theme.space[3],
          gap: theme.space[2],
        },
      ]}
    >
      <Search size={22} color={theme.colors.ink2} />
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        placeholder={label}
        placeholderTextColor={theme.colors.ink2}
        value={value}
        onChangeText={onChange}
        returnKeyType="search"
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={[theme.type.body, styles.input, { color: theme.colors.ink, minHeight: theme.size.primaryTouch }]}
      />
    </View>
  );
}

/**
 * One hit from the server. On the phone already: the usual row. Not yet: the server's words, and the
 * record is fetched when opened. Its label is shown as given (R-06).
 */
export function ServerResultRow({ result, pageId, q }: { result: ServerResult; pageId?: string; q: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const open = (id: string) =>
    router.navigate({ pathname: '/record/[id]', params: pageId ? { id, from: pageId } : { id, q } });
  const { hit, record } = result;
  if (record) return <RecordRow record={record} snippet={hit.snippet} onPress={() => open(record.id)} />;
  const title = hit.title ?? hit.snippet;
  return (
    <Pressable
      testID={`search-hit-${hit.item_id}`}
      accessibilityRole="button"
      accessibilityLabel={[title, hit.snippet, hit.ai_label].filter(Boolean).join('. ')}
      onPress={() => {
        void fetchRecord(hit.item_id)
          .then((rec) => {
            if (rec) open(rec.id);
            else showToast(t('search.open_failed'), 4000);
          })
          .catch(() => showToast(t('search.open_failed'), 4000));
      }}
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.line,
          borderRadius: theme.radius.card,
          padding: theme.space[4],
          marginBottom: theme.space[3],
          minHeight: theme.size.primaryTouch,
          gap: theme.space[1],
        },
      ]}
    >
      <AppText numberOfLines={3}>{title}</AppText>
      {hit.title ? <AppText variant="meta">{hit.snippet}</AppText> : null}
      {hit.ai_label ? <AppText variant="meta">{hit.ai_label}</AppText> : null}
    </Pressable>
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
    <View style={{ gap: theme.space[2] }}>
      {words.map((r) => (
        <ServerResultRow key={r.key} result={r} pageId={pageId} q={q} />
      ))}
      {meaning.length > 0 ? (
        <AppText testID="search-more-title" variant="section" accessibilityRole="header">
          {t('search.found_more', { n: meaning.length })}
        </AppText>
      ) : null}
      {meaning.map((r) => (
        <ServerResultRow key={r.key} result={r} pageId={pageId} q={q} />
      ))}
      {state === 'loading' ? (
        <AppText testID="search-looking" variant="meta">
          {t('search.looking')}
        </AppText>
      ) : null}
      {state === 'offline' ? (
        <AppText testID="search-offline" variant="meta" accessibilityLiveRegion="polite">
          {t('search.offline')}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  input: { flex: 1 },
  card: { borderWidth: 1 },
});
