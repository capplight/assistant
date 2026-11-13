import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ellipsis, FilePlus, FolderOpen, Layers } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import type { CollectionOut } from '@/api/types';
import { repeatsCount, stacksOf, takeApartStack, visibleGroups } from '@/dedup/service';
import { useDedup } from '@/dedup/store';
import type { PageEntry } from '@/pages/contents';
import type { Page } from '@/store/pages';
import { stackToPage } from '@/pages/viewService';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { ActionList, Button, Card, Chip, Icon, Sheet } from './ui';
import { PageIcon } from './Icon';

const ICON_KEYS = new Set(['documents', 'tasks', 'shopping', 'work', 'money', 'other', 'people', 'health', 'home']);
type StackIcon = 'documents' | 'tasks' | 'shopping' | 'work' | 'money' | 'other' | 'people' | 'health' | 'home';
export const stackIcon = (c: CollectionOut): StackIcon => (ICON_KEYS.has(c.icon) ? (c.icon as StackIcon) : 'other');

/** The stack's name in the interface language (`title_kk`, 2-design 3.3). */
export function stackTitle(c: CollectionOut, lang: string): string {
  return (lang === 'kk' && c.title_kk) || c.title;
}

/** How many of the page's rows are in the stack (its rows carry `group_key = title`); the server's count before sync. */
export function stackCount(c: CollectionOut, entries: PageEntry[] | null): number {
  const n = (entries ?? []).filter((e) => e.link?.groupKey === c.title).length;
  return n > 0 ? n : c.item_count;
}

/** «было 37, убрал 23 повтора» (2-design 3.4), only when repeats were removed. */
export function beforeAfterText(c: CollectionOut, t: (k: string, o?: Record<string, unknown>) => string): string | null {
  const ba = c.before_after;
  if (!ba || !ba.removed || ba.removed <= 0) return null;
  const before = ba.before ?? (ba.after !== null ? ba.after + ba.removed : null);
  return before !== null ? t('stack.before_after', { before, removed: ba.removed }) : null;
}

/**
 * «Заметки»: «стопки + последние» (2-design 3.1, 3.7, S37). Two or three stacks as big cards with
 * the count and «было → стало», the rest as chips (a list at a large font), each with a visible
 * [⋯ Ещё] (Открыть / Разобрать стопку). A tap opens S11 inside the page. Plus the card
 * «Похожие записи: N [Посмотреть]» when there are groups to decide. The page's own list below is
 * unchanged: the person's order stays as it is.
 */
export function StackCards({ page, entries, piles = false }: { page: Page; entries: PageEntry[] | null; piles?: boolean }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const src = useDedup(useShallow((s) => ({ collections: s.collections, gone: s.goneCollections, groups: s.groups, decided: s.decided })));
  const [menu, setMenu] = useState<CollectionOut | null>(null);
  const stacks = stacksOf(src.collections, src.gone, page.serverId, (page.groups ?? []).map((g) => g.title));
  const repeats = page.templateKey === 'notes' ? repeatsCount(visibleGroups(src.groups, src.decided)) : 0;
  if (stacks.length === 0 && repeats === 0) return null;
  // Week 11а piles (template-screens 2.1): two side by side, the rest as chips; one column at ≥150%.
  const bigCount = theme.largeFont ? stacks.length : piles ? 2 : 3;
  const big = stacks.slice(0, bigCount);
  const grid = piles && !theme.largeFont;
  // A pile shows its top sticker: its colour and two lines of it.
  const topOf = (c: CollectionOut) => (entries ?? []).find((e) => e.link?.groupKey === c.title) ?? null;
  const chips = stacks.slice(bigCount);
  const open = (c: CollectionOut) => router.navigate({ pathname: '/stack/[id]', params: { id: c.id, from: page.id } });

  return (
    <View style={{ gap: theme.space[3] }}>
      {repeats > 0 ? (
        <Card testID="notes-repeats" tone="brandTint" style={{ gap: theme.space[2], padding: theme.space[3] }}>
          <AppText>{t('dup.notes_card', { count: repeats })}</AppText>
          <Button
            testID="notes-repeats-open"
            label={t('dup.look')}
            accessibilityLabel={t('dup.look_a11y')}
            variant="text"
            style={styles.start}
            onPress={() => router.push('/duplicates')}
          />
        </Card>
      ) : null}
      {stacks.length > 0 ? (
        <AppText variant="sectionLabel" accessibilityRole="header">
          {t('stack.section')}
        </AppText>
      ) : null}
      <View style={grid ? [styles.row, { alignItems: 'stretch', gap: theme.space[3] }] : { gap: theme.space[3] }}>
      {big.map((c) => {
        const name = stackTitle(c, i18n.language);
        const count = stackCount(c, entries);
        const ba = beforeAfterText(c, t);
        const top = piles ? topOf(c) : null;
        const bg = piles ? theme.notes[top?.link?.color ?? 'white'] : theme.colors.surface;
        const preview = top ? (top.record.text ?? top.record.title ?? '').trim() : '';
        return (
          <View key={c.id} testID={piles ? `pile-${c.id}` : undefined} style={[{ paddingBottom: theme.space[1] }, grid ? styles.flex : null]}>
            <View
              style={[
                grid ? styles.flex : null,
                theme.elevation.card,
                {
                  backgroundColor: bg,
                  borderRadius: piles ? theme.radius.md : theme.radius.lg,
                  padding: theme.space[3],
                  gap: theme.space[1],
                },
              ]}
            >
              <Pressable
                testID={`stack-${c.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${t('stack.count_a11y', { title: name, count })}${ba ? `. ${ba}` : ''}`}
                onPress={() => open(c)}
                onLongPress={() => setMenu(c)}
                delayLongPress={400}
                style={{ minHeight: theme.size.minTouch, gap: theme.space[1] }}
              >
                <View style={[styles.row, { gap: theme.space[2] }]}>
                  <PageIcon name={stackIcon(c)} color={theme.colors.ink2} size={20} />
                  <AppText variant="headline" style={styles.flex}>
                    {name}
                  </AppText>
                  <AppText variant="headline" color="ink2">
                    {String(count)}
                  </AppText>
                </View>
                {ba ? <AppText variant="footnote">{ba}</AppText> : null}
                {preview ? (
                  <AppText variant="callout" color="ink" numberOfLines={2}>
                    {preview}
                  </AppText>
                ) : null}
              </Pressable>
              <View style={[styles.row, { justifyContent: 'flex-end' }]}>
                <Pressable
                  testID={`stack-menu-${c.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={t('stack.menu_a11y', { title: name })}
                  onPress={() => setMenu(c)}
                  style={[styles.center, { width: theme.size.minTouch, height: theme.size.minTouch }]}
                >
                  <Icon icon={Ellipsis} size="sm" color="iconSecondary" />
                </Pressable>
              </View>
            </View>
            {/* the sheet under it (+4): a stack, not a folder; a pile of stickers has two */}
            <View style={[styles.under, { borderRadius: piles ? theme.radius.md : theme.radius.lg, backgroundColor: theme.colors.surfaceSunken }]} />
            {piles ? <View style={[styles.under2, { borderRadius: theme.radius.md, backgroundColor: theme.colors.separator }]} /> : null}
          </View>
        );
      })}
      </View>
      {chips.length > 0 ? (
        <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
          {chips.map((c) => {
            const name = stackTitle(c, i18n.language);
            const count = stackCount(c, entries);
            return (
              <Chip
                key={c.id}
                testID={`stack-chip-${c.id}`}
                variant="neutral"
                label={`${name} · ${count}`}
                accessibilityLabel={t('stack.count_a11y', { title: name, count })}
                onPress={() => open(c)}
              />
            );
          })}
        </View>
      ) : null}
      {menu ? (
        <Sheet visible testID="stack-menu-sheet" title={stackTitle(menu, i18n.language)} onClose={() => setMenu(null)}>
          <ActionList
            actions={[
              {
                key: 'open',
                testID: 'stack-menu-open',
                label: t('stack.open'),
                icon: FolderOpen,
                onPress: () => {
                  const c = menu;
                  setMenu(null);
                  open(c);
                },
              },
              {
                key: 'to-page',
                testID: 'stack-menu-to-page',
                label: t('stack.to_page'),
                hint: t('stack.to_page_hint'),
                icon: FilePlus,
                onPress: () => {
                  const c = menu;
                  setMenu(null);
                  void stackToPage(c).then((pageId) => {
                    if (pageId) router.navigate({ pathname: '/page/[id]', params: { id: pageId } });
                  });
                },
              },
              {
                key: 'apart',
                testID: 'stack-menu-take-apart',
                label: t('stack.take_apart'),
                hint: t('stack.take_apart_hint'),
                icon: Layers,
                onPress: () => {
                  const c = menu;
                  setMenu(null);
                  void takeApartStack(c);
                },
              },
            ]}
          />
          <AppText variant="footnote">{t('stack.take_apart_hint')}</AppText>
        </Sheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  start: { alignSelf: 'flex-start' },
  under: { position: 'absolute', left: 6, right: 6, top: 6, bottom: -2, zIndex: -1 },
  under2: { position: 'absolute', left: 12, right: 12, top: 12, bottom: -6, zIndex: -2 },
});
