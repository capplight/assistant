import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import type { CollectionOut } from '@/api/types';
import { repeatsCount, stacksOf, takeApartStack, visibleGroups } from '@/dedup/service';
import { useDedup } from '@/dedup/store';
import type { PageEntry } from '@/pages/contents';
import type { Page } from '@/store/pages';
import { stackToPage } from '@/pages/viewService';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';
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
export function StackCards({ page, entries }: { page: Page; entries: PageEntry[] | null }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const src = useDedup(useShallow((s) => ({ collections: s.collections, gone: s.goneCollections, groups: s.groups, decided: s.decided })));
  const [menu, setMenu] = useState<CollectionOut | null>(null);
  const stacks = stacksOf(src.collections, src.gone, page.serverId, (page.groups ?? []).map((g) => g.title));
  const repeats = page.templateKey === 'notes' ? repeatsCount(visibleGroups(src.groups, src.decided)) : 0;
  if (stacks.length === 0 && repeats === 0) return null;
  const bigCount = theme.largeFont ? stacks.length : 3;
  const big = stacks.slice(0, bigCount);
  const chips = stacks.slice(bigCount);
  const open = (c: CollectionOut) => router.navigate({ pathname: '/stack/[id]', params: { id: c.id, from: page.id } });

  return (
    <View style={{ gap: theme.space[3] }}>
      {repeats > 0 ? (
        <View
          testID="notes-repeats"
          style={[styles.card, { borderColor: theme.colors.line, backgroundColor: theme.colors.surface, borderRadius: theme.radius.card, padding: theme.space[3], gap: theme.space[2] }]}
        >
          <AppText>{t('dup.notes_card', { count: repeats })}</AppText>
          <Button
            testID="notes-repeats-open"
            label={t('dup.look')}
            accessibilityLabel={t('dup.look_a11y')}
            variant="outline"
            minHeight={theme.size.minTouch}
            onPress={() => router.push('/duplicates')}
          />
        </View>
      ) : null}
      {stacks.length > 0 ? (
        <AppText variant="section" accessibilityRole="header">
          {t('stack.section')}
        </AppText>
      ) : null}
      {big.map((c) => {
        const name = stackTitle(c, i18n.language);
        const count = stackCount(c, entries);
        const ba = beforeAfterText(c, t);
        return (
          <View key={c.id} style={{ paddingBottom: theme.space[1] }}>
            <View
              style={[
                styles.card,
                {
                  borderColor: theme.colors.line,
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.card,
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
                style={{ minHeight: theme.size.primaryTouch, gap: theme.space[1] }}
              >
                <View style={[styles.row, { gap: theme.space[2] }]}>
                  <PageIcon name={stackIcon(c)} color={theme.colors.ink} size={24} />
                  <AppText variant="title2" style={styles.flex}>
                    {name}
                  </AppText>
                  <AppText variant="title2">{String(count)}</AppText>
                </View>
                {ba ? <AppText variant="meta">{ba}</AppText> : null}
              </Pressable>
              <View style={[styles.row, { justifyContent: 'flex-end' }]}>
                <Button
                  testID={`stack-menu-${c.id}`}
                  label={`⋯ ${t('stack.menu')}`}
                  accessibilityLabel={t('stack.menu_a11y', { title: name })}
                  variant="text"
                  minHeight={theme.size.minTouch}
                  onPress={() => setMenu(c)}
                />
              </View>
            </View>
            {/* the sheet under it (+4): a stack, not a folder */}
            <View style={[styles.under, { borderColor: theme.colors.line, borderRadius: theme.radius.card, backgroundColor: theme.colors.bg }]} />
          </View>
        );
      })}
      {chips.length > 0 ? (
        <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
          {chips.map((c) => {
            const name = stackTitle(c, i18n.language);
            const count = stackCount(c, entries);
            return (
              <Pressable
                key={c.id}
                testID={`stack-chip-${c.id}`}
                accessibilityRole="button"
                accessibilityLabel={t('stack.count_a11y', { title: name, count })}
                onPress={() => open(c)}
                style={[
                  styles.chip,
                  { minHeight: theme.size.minTouch, borderColor: theme.colors.lineStrong, borderRadius: theme.radius.button, paddingHorizontal: theme.space[3] },
                ]}
              >
                <AppText>{`${name} ${count}`}</AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <Modal visible={!!menu} transparent animationType="slide" onRequestClose={() => setMenu(null)}>
        <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
          <SafeAreaView
            edges={['bottom']}
            style={{ backgroundColor: theme.colors.surface, borderTopLeftRadius: theme.radius.sheet, borderTopRightRadius: theme.radius.sheet, padding: theme.space[5], gap: theme.space[2] }}
          >
            {menu ? (
              <>
                <AppText variant="title2" accessibilityRole="header">
                  {stackTitle(menu, i18n.language)}
                </AppText>
                <Button
                  testID="stack-menu-open"
                  label={t('stack.open')}
                  variant="outline"
                  onPress={() => {
                    const c = menu;
                    setMenu(null);
                    open(c);
                  }}
                />
                <Button
                  testID="stack-menu-to-page"
                  label={t('stack.to_page')}
                  accessibilityHint={t('stack.to_page_hint')}
                  variant="outline"
                  onPress={() => {
                    const c = menu;
                    setMenu(null);
                    void stackToPage(c).then((pageId) => {
                      if (pageId) router.navigate({ pathname: '/page/[id]', params: { id: pageId } });
                    });
                  }}
                />
                <Button
                  testID="stack-menu-take-apart"
                  label={t('stack.take_apart')}
                  accessibilityHint={t('stack.take_apart_hint')}
                  variant="text"
                  onPress={() => {
                    const c = menu;
                    setMenu(null);
                    void takeApartStack(c);
                  }}
                />
                <AppText variant="meta">{t('stack.take_apart_hint')}</AppText>
                <Button testID="stack-menu-close" label={t('common.close')} variant="text" onPress={() => setMenu(null)} />
              </>
            ) : null}
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  card: { borderWidth: 1 },
  under: { position: 'absolute', left: 4, right: -4, top: 4, bottom: -2, borderWidth: 1, zIndex: -1 },
  chip: { borderWidth: 1, justifyContent: 'center' },
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
