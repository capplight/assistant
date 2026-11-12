import { router } from 'expo-router';
import { BellRing, ChevronRight, Ellipsis, UserRound } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PageIcon } from '@/components/Icon';
import { setTodayTile } from '@/today/tileService';
import { usePages } from '@/store/pages';
import type { Tile } from '@/today/tiles';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';

/**
 * «Сегодня» as a tear-off sheet (template-screens 2.7): the day's number large on a «листок»,
 * the weekday and the greeting next to it; the avatar opens «Ещё». At ≥150% the sheet becomes one
 * line «Вторник, 10 ноября» (no clipped numbers).
 */
export function TodayHeader({ now, greeting }: { now: number; greeting: string }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const d = new Date(now);
  const fmt = (o: Intl.DateTimeFormatOptions) => {
    try {
      return d.toLocaleDateString(i18n.language, o);
    } catch {
      return d.toDateString();
    }
  };
  const weekday = fmt({ weekday: 'long' });
  const dayMonth = fmt({ day: 'numeric', month: 'long' });
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  // «10 ноября» → «ноября» under the big number (the genitive the locale gives).
  const monthWord = dayMonth.replace(/\d+/g, '').replace(/[.,]/g, '').trim();
  const avatar = (
    <Pressable
      testID="today-profile"
      accessibilityRole="button"
      accessibilityLabel={t('today.profile')}
      onPress={() => router.navigate('/more')}
      style={[
        styles.avatar,
        {
          width: theme.size.minTouch,
          height: theme.size.minTouch,
          borderRadius: theme.radius.round,
          borderColor: theme.colors.iconSecondary,
        },
      ]}
    >
      <UserRound size={24} color={theme.colors.ink} />
    </Pressable>
  );

  if (theme.largeFont) {
    return (
      <View style={{ marginBottom: theme.space[6] }}>
        <View style={styles.row}>
          <AppText testID="today-date" variant="title2" style={styles.flex} accessibilityRole="header">
            {`${cap(weekday)}, ${dayMonth}`}
          </AppText>
          {avatar}
        </View>
        <AppText variant="largeTitle">{greeting}</AppText>
      </View>
    );
  }

  return (
    <View style={[styles.row, { alignItems: 'flex-start', gap: theme.space[4], marginBottom: theme.space[6] }]}>
      <View
        testID="today-sheet"
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${cap(weekday)}, ${dayMonth}`}
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.iconSecondary,
            borderRadius: theme.radius.lg,
            paddingVertical: theme.space[2],
            paddingHorizontal: theme.space[3],
          },
        ]}
      >
        <View style={[styles.perforation, { borderColor: theme.colors.separator }]} />
        <AppText variant="largeTitle" style={styles.center}>
          {String(d.getDate())}
        </AppText>
        <AppText variant="callout" color="ink" style={styles.center}>
          {monthWord}
        </AppText>
      </View>
      <View style={styles.flex}>
        <AppText testID="today-date" variant="title2">
          {cap(weekday)}
        </AppText>
        <AppText variant="body" style={{ marginTop: theme.space[1] }}>
          {greeting}
        </AppText>
      </View>
      {avatar}
    </View>
  );
}

export type NextItem =
  | { kind: 'reminder'; key: string; title: string; at: number; alarm: boolean }
  | { kind: 'task'; key: string; title: string; at: null };

/** «Дальше» — one large card: the nearest ring or to-do with [Сделано] [Отложить на 10 минут] (S14 words). */
export function NextCard({
  next,
  now,
  onDone,
  onSnooze,
}: {
  next: NextItem;
  now: number;
  onDone: () => void;
  onSnooze?: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  let when = '';
  if (next.at !== null) {
    const min = Math.max(0, Math.round((next.at - now) / 60_000));
    when = min < 1 ? t('today.next_now') : min < 60 ? t('today.next_in_min', { n: min }) : t('today.next_in_h', { h: Math.floor(min / 60), m: min % 60 });
  }
  const time = next.at !== null ? new Date(next.at).toTimeString().slice(0, 5) : '';
  const label = [t('today.next'), when, time, next.title].filter(Boolean).join('. ');
  return (
    <View
      testID="today-next"
      style={{
        borderWidth: 2,
        borderColor: theme.colors.brand,
        borderRadius: theme.radius.lg,
        backgroundColor: theme.colors.surface,
        padding: theme.space[4],
        gap: theme.space[3],
        marginBottom: theme.space[6],
      }}
    >
      <View accessible accessibilityLabel={label}>
        <AppText variant="sectionLabel" color="brand">
          {when ? `${t('today.next')} · ${when}` : t('today.next')}
        </AppText>
        <View style={[styles.row, { gap: theme.space[2], marginTop: theme.space[2] }]}>
          {next.kind === 'reminder' ? <BellRing size={24} color={next.alarm ? theme.colors.danger : theme.colors.ink} /> : null}
          <AppText variant="title2" style={styles.flex}>
            {time ? `${time} ${next.title}` : next.title}
          </AppText>
        </View>
      </View>
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[2] }}>
        <Button
          testID="today-next-done"
          label={t('alarm.done')}
          accessibilityLabel={`${t('alarm.done')}: ${next.title}`}
          style={theme.largeFont ? undefined : { flex: 1 }}
          onPress={onDone}
        />
        {onSnooze ? (
          <Button
            testID="today-next-snooze"
            label={t('alarm.snooze')}
            variant="secondary"
            style={theme.largeFont ? undefined : { flex: 1 }}
            onPress={onSnooze}
          />
        ) : null}
      </View>
    </View>
  );
}

/** «На страницах»: ≤2 tiles, one column at ≥150%; each opens its page; «⋯» pins or hides it. */
export function PageTiles({ tiles }: { tiles: Tile[] }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const pages = usePages((s) => s.pages);
  const [menu, setMenu] = useState<Tile | null>(null);
  if (tiles.length === 0) return null;
  const pageOf = (id: string) => pages.find((p) => p.id === id);
  const nameOf = (tile: Tile) => {
    const p = pageOf(tile.pageId);
    if (p?.title) return p.title;
    const key = p?.templateKey ?? tile.templateKey;
    return t(key === 'custom' ? 'tpl.custom_default' : `tpl.${key}`);
  };
  const menuPage = menu ? pageOf(menu.pageId) : undefined;
  return (
    <View testID="today-tiles" style={{ marginBottom: theme.space[6] }}>
      <AppText variant="sectionLabel" accessibilityRole="header" style={{ marginBottom: theme.space[3] }}>
        {t('today.on_pages')}
      </AppText>
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[3] }}>
        {tiles.map((tile) => {
          const p = pageOf(tile.pageId);
          const name = nameOf(tile);
          const line = tile.text;
          return (
            <View
              key={tile.pageId}
              style={[
                styles.tile,
                {
                  borderColor: theme.colors.separator,
                  borderRadius: theme.radius.lg,
                  backgroundColor: theme.colors.surface,
                  flex: theme.largeFont ? undefined : 1,
                },
              ]}
            >
              <Pressable
                testID={`today-tile-${tile.pageId}`}
                accessibilityRole="button"
                accessibilityLabel={`${name}. ${line}`}
                accessibilityHint={t('pages.open')}
                onPress={() => router.navigate({ pathname: '/page/[id]', params: { id: tile.pageId } })}
                style={{ padding: theme.space[3], minHeight: 96, gap: theme.space[1] }}
              >
                <View style={[styles.row, { gap: theme.space[2] }]}>
                  {p ? <PageIcon name={p.icon} color={theme.colors.ink} size={22} /> : null}
                  <AppText variant="bodyStrong" style={styles.flex}>
                    {name}
                  </AppText>
                </View>
                <View style={[styles.row, { gap: theme.space[2] }]}>
                  <AppText variant="title2" style={styles.flex}>
                    {tile.text}
                  </AppText>
                  <ChevronRight size={22} color={theme.colors.ink2} />
                </View>
              </Pressable>
              <Pressable
                testID={`today-tile-menu-${tile.pageId}`}
                accessibilityRole="button"
                accessibilityLabel={t('today.tile_menu_a11y', { page: name })}
                onPress={() => setMenu(tile)}
                style={[styles.tileMenu, { width: theme.size.minTouch, height: theme.size.minTouch }]}
              >
                <Ellipsis size={22} color={theme.colors.ink2} />
              </Pressable>
            </View>
          );
        })}
      </View>
      <Modal visible={menu !== null} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
        <Pressable style={[styles.backdrop, { backgroundColor: theme.colors.scrim }]} onPress={() => setMenu(null)} accessibilityLabel={t('common.close')}>
          <SafeAreaView edges={['bottom']} style={[{ backgroundColor: theme.colors.surfaceRaised, borderTopLeftRadius: theme.radius.sheet, borderTopRightRadius: theme.radius.sheet, padding: theme.space[5], gap: theme.space[2] }, theme.elevation.floating]}>
            {menu ? (
              <>
                <AppText variant="title2" accessibilityRole="header">
                  {nameOf(menu)}
                </AppText>
                <Button
                  testID="tile-pin"
                  variant="secondary"
                  label={menu.pinned ? t('today.tile_unpin') : t('today.tile_pin')}
                  onPress={() => {
                    setMenu(null);
                    if (menuPage) void setTodayTile(menuPage, menu.pinned ? 'auto' : 'pinned');
                  }}
                />
                <Button
                  testID="tile-hide"
                  variant="secondary"
                  label={t('today.tile_hide')}
                  onPress={() => {
                    setMenu(null);
                    if (menuPage) void setTodayTile(menuPage, 'hidden');
                  }}
                />
                <Button testID="tile-cancel" variant="text" label={t('common.cancel')} onPress={() => setMenu(null)} />
              </>
            ) : null}
          </SafeAreaView>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  avatar: { borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  sheet: { borderWidth: 1, minWidth: 96, alignItems: 'center' },
  perforation: { alignSelf: 'stretch', borderTopWidth: 2, borderStyle: 'dashed', marginBottom: 4 },
  tile: { borderWidth: 1 },
  tileMenu: { position: 'absolute', top: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
});
