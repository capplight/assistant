import { router, usePathname, useGlobalSearchParams } from 'expo-router';
import { FileText } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { resolveSource } from '@/chat/service';
import { formatShortDate } from '@/records/format';
import { usePageLabels } from '@/pages/usePageLabels';
import type { ChatSource } from '@/store/assistant';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

import { AppText } from './AppText';

/** Where «‹ Назад к ответу» goes: this screen, with the answer focused when it is «Переписка». */
export function useReturnHref(messageId: string): string {
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string }>();
  if (pathname === '/chat') return `/chat?focus=${encodeURIComponent(messageId)}`;
  if (pathname.startsWith('/page/') && params.id) return `/page/${encodeURIComponent(params.id)}`;
  return pathname || '/';
}

/** «Заметки · 3 ноя» — the page the record is on and its date; the title when there is no page. */
export function useSourceLabel(): (s: ChatSource) => { label: string; a11y: string } {
  const { t, i18n } = useTranslation();
  const pages = usePages((st) => st.pages);
  const { title } = usePageLabels();
  return (s) => {
    const local = s.pageServerId ? pages.find((p) => p.serverId === s.pageServerId) : undefined;
    const page = local ? title(local) : s.pageTitle;
    const date = s.occurredAt ? formatShortDate(s.occurredAt, i18n.language) : null;
    const label = s.label || [page, date].filter(Boolean).join(' · ') || s.title || t('answer.source');
    return {
      label,
      a11y: t('answer.source_a11y', { title: s.title ?? label, where: [page, date].filter(Boolean).join(', ') }),
    };
  };
}

/**
 * Source chips under an answer (2-design §4.4 п. 5): a chip opens the record on its page, with
 * «‹ Назад к ответу» on top. `max`: the banner shows two and «ещё N» (which opens the answer).
 */
export function SourceChips({
  messageId,
  sources,
  max,
  onMore,
}: {
  messageId: string;
  sources: ChatSource[];
  max?: number;
  onMore?: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const ret = useReturnHref(messageId);
  const labelOf = useSourceLabel();
  const showToast = useToast((s) => s.show);
  if (sources.length === 0) return null;
  const shown = max ? sources.slice(0, max) : sources;
  const rest = sources.length - shown.length;

  const open = async (s: ChatSource) => {
    const target = await resolveSource(s);
    if (!target) {
      showToast(t('search.open_failed'), 3000);
      return;
    }
    router.navigate({
      pathname: '/record/[id]',
      params: { id: target.recordId, ret, ...(target.pageId ? { from: target.pageId } : {}) },
    });
  };

  const chipStyle = [
    styles.chip,
    {
      minHeight: theme.size.minTouch,
      borderRadius: theme.radius.round,
      backgroundColor: theme.colors.surfaceSunken,
      paddingHorizontal: theme.space[3],
      gap: theme.space[1],
    },
  ];

  return (
    <View style={[styles.row, { gap: theme.space[2] }]}>
      {shown.map((s) => {
        const { label, a11y } = labelOf(s);
        return (
          <Pressable
            key={s.ref}
            testID={`source-${s.itemId}`}
            accessibilityRole="button"
            accessibilityLabel={a11y}
            onPress={() => void open(s)}
            style={chipStyle}
          >
            <FileText size={18} color={theme.colors.iconSecondary} strokeWidth={1.75} />
            <AppText variant="callout" color="ink" numberOfLines={1} style={styles.shrink}>
              {label}
            </AppText>
          </Pressable>
        );
      })}
      {rest > 0 && onMore ? (
        <Pressable
          testID="source-more"
          accessibilityRole="button"
          accessibilityLabel={t('answer.more_sources_a11y', { n: rest })}
          onPress={onMore}
          style={chipStyle}
        >
          <AppText variant="callout" color="ink">
            {t('answer.more_sources', { n: rest })}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Offline: records found on the phone by words. They are local already, so they open at once. */
export function LocalHitChips({ messageId, recordIds, titles }: { messageId: string; recordIds: string[]; titles: Record<string, string> }) {
  const theme = useTheme();
  const ret = useReturnHref(messageId);
  if (recordIds.length === 0) return null;
  return (
    <View style={[styles.row, { gap: theme.space[2] }]}>
      {recordIds.slice(0, 2).map((id) => (
        <Pressable
          key={id}
          testID={`local-hit-${id}`}
          accessibilityRole="button"
          accessibilityLabel={titles[id] ?? id}
          onPress={() => router.navigate({ pathname: '/record/[id]', params: { id, ret } })}
          style={[
            styles.chip,
            {
              minHeight: theme.size.minTouch,
              borderRadius: theme.radius.round,
              backgroundColor: theme.colors.surfaceSunken,
              paddingHorizontal: theme.space[3],
              gap: theme.space[1],
            },
          ]}
        >
          <FileText size={18} color={theme.colors.iconSecondary} strokeWidth={1.75} />
          <AppText variant="callout" color="ink" numberOfLines={1} style={styles.shrink}>
            {titles[id] ?? ''}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * The sources of an answer as numbered rows («1  Заметки · 3 ноя ›»), for the search screen: the answer's
 * «[1]» marks point here. A row opens the record with «‹ Назад к ответу».
 */
export function NumberedSources({ messageId, sources }: { messageId: string; sources: ChatSource[] }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const ret = useReturnHref(messageId);
  const labelOf = useSourceLabel();
  const showToast = useToast((s) => s.show);
  if (sources.length === 0) return null;
  const open = async (s: ChatSource) => {
    const target = await resolveSource(s);
    if (!target) return showToast(t('search.open_failed'), 3000);
    router.navigate({ pathname: '/record/[id]', params: { id: target.recordId, ret, ...(target.pageId ? { from: target.pageId } : {}) } });
  };
  return (
    <View testID="answer-sources">
      {sources.map((s, i) => {
        const { label, a11y } = labelOf(s);
        return (
          <Pressable
            key={s.ref}
            testID={`answer-source-${i + 1}`}
            accessibilityRole="button"
            accessibilityLabel={`${i + 1}. ${a11y}`}
            onPress={() => void open(s)}
            style={({ pressed }) => [
              { flexDirection: 'row', alignItems: 'center', gap: theme.space[3], minHeight: theme.size.minTouch, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.separator },
              pressed ? { backgroundColor: theme.colors.surfaceSunken } : null,
            ]}
          >
            <View style={{ minWidth: 24, minHeight: 24, borderRadius: 12, backgroundColor: theme.colors.brandTint, alignItems: 'center', justifyContent: 'center' }}>
              <AppText variant="footnote" color="brand" style={{ fontFamily: theme.type.sectionLabel.fontFamily }}>
                {String(i + 1)}
              </AppText>
            </View>
            <View style={styles.shrinkRow}>
              {s.title ? <AppText>{s.title}</AppText> : null}
              <AppText variant="callout">{label}</AppText>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap' },
  shrinkRow: { flex: 1, paddingVertical: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', maxWidth: '100%' },
  shrink: { flexShrink: 1 },
});
