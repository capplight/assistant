import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import type { DuplicateGroupOut, DuplicateMemberOut } from '@/api/types';
import { cleanupPreview } from '@/api/endpoints';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/Screen';
import {
  confirmCleanup,
  dismissGroup,
  liveCleanup,
  mergeGroup,
  mergeMarked,
  planCleanup,
  refreshGroups,
  rejectCleanup,
  repeatsCount,
  visibleGroups,
} from '@/dedup/service';
import { useDedup } from '@/dedup/store';
import { formatShortDate } from '@/records/format';
import { useConnectivity } from '@/store/connectivity';
import { useTheme } from '@/theme';

const SHOWN_MEMBERS = 3;

/**
 * S26 «Повторы» (2-design 3.6, 5.3; 3-engineering 6.3): the exact repeats found in what was
 * already there as ONE «Да» on the batch («Убрать повторы: 37 → 1?», S25: the numbers, what stays,
 * «Вернуть можно 30 дней»; [Да, убрать] / [Нет], nothing happens by itself), and the near repeats
 * by group: «Оставлю эту (самая полная)» ↔ «Уберу: N» with [Объединить] (that tap is the «Да» for
 * this group) and [Это разные]. The person may choose another record to keep. The text is joined
 * by code on the server; every merge has «Отменить». Needs the internet to change anything.
 * Week 11 (week 10 alignment): each group can be marked; «Объединить все отмеченные (N)» is the
 * one «Да» for all of them (`POST /duplicates/merge`), one action and one «Отменить». [Это разные]
 * has «Отменить» too (`dismiss_group`).
 */
export default function DuplicatesScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const src = useDedup(useShallow((s) => ({ groups: s.groups, decided: s.decided, cleanup: s.cleanup })));
  const online = useConnectivity((s) => s.online);
  const [loaded, setLoaded] = useState(false);
  /** Marked groups → the record the person keeps in each («Объединить все отмеченные»). */
  const [marked, setMarked] = useState<Record<string, string | null>>({});
  const [busyAll, setBusyAll] = useState(false);
  const groups = visibleGroups(src.groups, src.decided);
  const markedList = groups.filter((g) => g.id in marked).map((group) => ({ group, keepItemId: marked[group.id] ?? null }));
  const cleanup = liveCleanup(src.cleanup);
  const preview = cleanupPreview(cleanup);

  useEffect(() => {
    void Promise.all([refreshGroups(), liveCleanup(useDedup.getState().cleanup) ? null : planCleanup()]).finally(() => setLoaded(true));
  }, []);

  return (
    <Screen testID="page-duplicates" edges={['top']}>
      <View style={[styles.row, { marginBottom: theme.space[4] }]}>
        <Button
          testID="dup-back"
          label={`‹ ${t('common.back')}`}
          variant="text"
          minHeight={theme.size.minTouch}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
        <AppText variant="largeTitle" accessibilityRole="header" style={styles.flex}>
          {t('dup.title')}
        </AppText>
      </View>
      <AppText variant="callout" style={{ marginBottom: theme.space[4] }}>
        {t('dup.hint')}
      </AppText>

      {cleanup && preview ? (
        <View
          testID="dup-batch"
          style={[styles.card, { borderColor: theme.colors.iconSecondary, backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: theme.space[4], gap: theme.space[3], marginBottom: theme.space[5] }]}
        >
          {/* «было 37, стало 1» reads as words to a screen reader (2-design 7.x check list). */}
          <AppText
            testID="dup-batch-title"
            variant="title2"
            accessibilityRole="header"
            accessibilityLabel={t('dedup.batch', { before: preview.before, after: preview.after }).replace('→', '—')}
          >
            {t('dedup.batch', { before: preview.before, after: preview.after })}
          </AppText>
          <AppText>{t('dup.batch_detail', { removed: preview.removed, after: preview.after })}</AppText>
          <View style={{ gap: theme.space[2] }}>
            <Button testID="dup-batch-yes" label={t('dup.batch_yes')} onPress={() => void confirmCleanup()} />
            <Button testID="dup-batch-no" label={t('dup.batch_no')} variant="secondary" onPress={() => void rejectCleanup()} />
          </View>
        </View>
      ) : null}

      {groups.length > 0 ? (
        <AppText testID="dup-found" style={{ marginBottom: theme.space[3] }}>
          {t('dup.found', { groups: groups.length, count: repeatsCount(groups) })}
        </AppText>
      ) : loaded && !cleanup ? (
        <AppText testID="dup-empty">{online ? t('dup.empty') : t('dup.offline_list')}</AppText>
      ) : null}

      {markedList.length > 0 ? (
        <Button
          testID="dup-merge-marked"
          label={t('dup.merge_marked', { count: markedList.length })}
          disabled={busyAll}
          style={{ marginBottom: theme.space[4] }}
          onPress={() => {
            setBusyAll(true);
            void mergeMarked(markedList).then((ok) => {
              setBusyAll(false);
              if (ok) setMarked({});
            });
          }}
        />
      ) : null}

      {groups.map((g) => (
        <GroupCard
          key={g.id}
          group={g}
          marked={g.id in marked}
          onMark={(keep) =>
            setMarked((m) => {
              const next = { ...m };
              if (keep === undefined) delete next[g.id];
              else next[g.id] = keep;
              return next;
            })
          }
        />
      ))}
    </Screen>
  );
}

function memberTitle(m: DuplicateMemberOut, t: (k: string) => string): string {
  const s = (m.title ?? m.snippet ?? '').trim();
  return s ? s.split('\n')[0]!.slice(0, 120) : t('dup.untitled');
}

function GroupCard({
  group,
  marked,
  onMark,
}: {
  group: DuplicateGroupOut;
  marked: boolean;
  /** The record kept when marked; undefined = not marked. */
  onMark: (keepItemId: string | null | undefined) => void;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const [keepId, setKeepId] = useState(group.keep_item_id ?? group.members[0]?.item_id ?? null);
  const [busy, setBusy] = useState(false);
  const keep = group.members.find((m) => m.item_id === keepId) ?? group.members[0]!;
  const others = group.members.filter((m) => m.item_id !== keep.item_id);
  const date = (m: DuplicateMemberOut) => {
    const iso = m.occurred_at ?? m.created_at;
    return iso ? formatShortDate(iso, i18n.language) : '';
  };
  const why =
    keep.item_id === group.keep_item_id && group.keep_rule
      ? group.keep_rule === 'newest'
        ? t('dup.keep_newest')
        : t('dup.keep_most_complete')
      : null;
  const keepTitle = memberTitle(keep, t);
  const run = (f: () => Promise<boolean>) => {
    setBusy(true);
    void f().finally(() => setBusy(false));
  };

  return (
    <View
      testID={`dup-group-${group.id}`}
      style={[styles.card, { borderColor: theme.colors.separator, backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: theme.space[4], gap: theme.space[2], marginBottom: theme.space[4] }]}
    >
      <AppText variant="callout">{why ? `${t('dup.keep')} · ${why}` : t('dup.keep')}</AppText>
      <AppText testID={`dup-keep-${group.id}`} variant="title2">
        {keepTitle}
      </AppText>
      {date(keep) ? <AppText variant="callout">{date(keep)}</AppText> : null}
      <AppText variant="callout" style={{ marginTop: theme.space[2] }}>
        {t('dup.will_remove', { count: others.length })}
      </AppText>
      {others.slice(0, SHOWN_MEMBERS).map((m) => {
        const title = memberTitle(m, t);
        return (
          <View key={m.item_id} style={[styles.row, { gap: theme.space[2], borderTopWidth: 1, borderTopColor: theme.colors.separator, paddingTop: theme.space[2] }]}>
            <View style={styles.flex}>
              <AppText>{title}</AppText>
              {date(m) ? <AppText variant="callout">{date(m)}</AppText> : null}
            </View>
            <Button
              testID={`dup-keep-this-${m.item_id}`}
              label={t('dup.keep_this')}
              accessibilityLabel={t('dup.keep_this_a11y', { title })}
              variant="text"
              minHeight={theme.size.minTouch}
              onPress={() => {
                setKeepId(m.item_id);
                if (marked) onMark(m.item_id);
              }}
            />
          </View>
        );
      })}
      {others.length > SHOWN_MEMBERS ? <AppText variant="callout">{t('dup.more', { count: others.length - SHOWN_MEMBERS })}</AppText> : null}
      <Pressable
        testID={`dup-mark-${group.id}`}
        accessibilityRole="checkbox"
        accessibilityLabel={t('dup.mark_a11y', { title: keepTitle })}
        accessibilityState={{ checked: marked }}
        onPress={() => onMark(marked ? undefined : keep.item_id)}
        style={[styles.row, { minHeight: theme.size.buttonHeight, gap: theme.space[2], marginTop: theme.space[2] }]}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: theme.colors.brand,
            backgroundColor: marked ? theme.colors.brand : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {marked ? <Check size={22} color={theme.colors.onBrand} /> : null}
        </View>
        <AppText>{t('dup.mark')}</AppText>
      </Pressable>
      <View style={{ gap: theme.space[2], marginTop: theme.space[2] }}>
        <Button
          testID={`dup-merge-${group.id}`}
          label={t('dup.merge')}
          accessibilityLabel={t('dup.merge_a11y', { title: keepTitle })}
          disabled={busy}
          onPress={() => run(() => mergeGroup(group, keep.item_id))}
        />
        <Button
          testID={`dup-different-${group.id}`}
          label={t('dup.different')}
          accessibilityLabel={t('dup.different_a11y', { title: keepTitle })}
          variant="secondary"
          disabled={busy}
          onPress={() => run(() => dismissGroup(group))}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  card: { borderWidth: 1 },
});
