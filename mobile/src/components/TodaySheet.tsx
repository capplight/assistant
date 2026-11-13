import { router } from 'expo-router';
import { BellRing, ChevronRight, Clock, Ellipsis, EyeOff, Pin, PinOff, Search, ShoppingBasket } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { setTodayTile } from '@/today/tileService';
import { usePages } from '@/store/pages';
import type { Tile } from '@/today/tiles';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { CheckCircle } from './ui/Check';
import { Header } from './ui/Header';
import { Icon, PageIcon } from './ui/Icon';
import { hitSlopFor, pressedStyle } from './ui/motion';
import { ActionList, Sheet } from './ui/Sheet';

/**
 * «Сегодня» header (design-system §4 mock): the weekday and date as the `footnote` meta, «Сегодня» as the
 * large title, one round button (search). The date is the screen's header for screen readers.
 */
export function TodayHeader({ now }: { now: number }) {
  const { t, i18n } = useTranslation();
  const d = new Date(now);
  let date: string;
  try {
    date = d.toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    date = d.toDateString();
  }
  const meta = date.charAt(0).toUpperCase() + date.slice(1);
  return (
    <View testID="today-header">
      <Header
        title={t('today.today')}
        meta={meta}
        actions={[{ key: 'search', icon: Search, label: t('today.search'), onPress: () => router.navigate('/search'), testID: 'today-search' }]}
      />
    </View>
  );
}

export type NextItem =
  | { kind: 'reminder'; key: string; title: string; at: number; alarm: boolean }
  | { kind: 'task'; key: string; title: string; at: null };

/**
 * «Дальше» — the one sun card of the screen (design-system §3 NextCard): meta `footnote` onHighlight2,
 * the time large, the title `title2`, [Сделано] dark on the sun and [Отложить] translucent.
 */
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
    <Card testID="today-next" tone="highlight" style={{ gap: theme.space[3], marginBottom: theme.space[2] }}>
      <View accessible accessibilityLabel={label} style={{ gap: theme.space[1] }}>
        <View style={[styles.row, { gap: theme.space[1] }]}>
          <Icon icon={next.kind === 'reminder' ? BellRing : Clock} size="sm" color="onHighlight2" />
          <AppText variant="footnote" color="onHighlight2" style={styles.flex}>
            {when ? `${t('today.next')} · ${when}` : t('today.next')}
          </AppText>
        </View>
        {time ? (
          <AppText variant="time" color="onHighlight">
            {time}
          </AppText>
        ) : null}
        <AppText variant="title2" color="onHighlight">
          {next.title}
        </AppText>
      </View>
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        <Button
          testID="today-next-done"
          tone="highlight"
          size="small"
          label={t('alarm.done')}
          accessibilityLabel={`${t('alarm.done')}: ${next.title}`}
          onPress={onDone}
        />
        {onSnooze ? (
          <Button
            testID="today-next-snooze"
            tone="highlight"
            variant="secondary"
            size="small"
            label={t('alarm.snooze_short')}
            accessibilityLabel={t('alarm.snooze')}
            onPress={onSnooze}
          />
        ) : null}
      </View>
    </Card>
  );
}

/** A row of the day's list: a 24 circle (48 target), the title, the time on the right (`danger` when overdue). */
export function TodayRow({
  title,
  time,
  overdue,
  done,
  onToggle,
  onPress,
  label,
  testID,
  checkTestID,
  separator,
}: {
  title: string;
  time?: string;
  overdue?: boolean;
  done: boolean;
  onToggle: () => void;
  onPress?: () => void;
  /** Spoken line (e.g. «Пропущено 10:00 · Позвонить»). */
  label?: string;
  testID?: string;
  checkTestID?: string;
  separator: boolean;
}) {
  const theme = useTheme();
  const body = (
    <View
      style={[
        styles.row,
        styles.flex,
        { minHeight: theme.size.rowHeight, gap: theme.space[2], paddingRight: theme.space[3], paddingVertical: theme.space[1] },
        separator ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.separator } : null,
      ]}
    >
      <AppText color={done ? 'ink3' : 'ink'} style={[styles.flex, done ? styles.struck : null]}>
        {title}
      </AppText>
      {time ? (
        <AppText variant="callout" color={overdue && !done ? 'danger' : done ? 'ink3' : 'ink2'} style={overdue && !done ? { fontFamily: theme.type.sectionLabel.fontFamily } : undefined}>
          {time}
        </AppText>
      ) : null}
    </View>
  );
  return (
    <View testID={testID} accessibilityLabel={label} style={[styles.row, { paddingLeft: theme.space[1] }]}>
      <CheckCircle testID={checkTestID} checked={done} label={label ?? title} onChange={onToggle} />
      {onPress ? (
        <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} onPress={onPress} style={({ pressed }) => [styles.flex, pressedStyle(pressed)]}>
          {body}
        </Pressable>
      ) : (
        body
      )}
    </View>
  );
}

/** «Купить: молоко и ещё 3» — the shopping list in one line; opens «Покупки» when it is a page. */
export function ShoppingLine({ titles, onPress, hint }: { titles: string[]; onPress?: () => void; hint?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [first, ...rest] = titles;
  const text = rest.length > 0 ? t('today.buy_more', { first, n: rest.length }) : t('today.buy_one', { first });
  const inner = (
    <View style={[styles.row, { minHeight: theme.size.rowHeight, gap: theme.space[3], paddingLeft: theme.space[3], paddingRight: theme.space[3] }]}>
      <Icon icon={ShoppingBasket} size="sm" color="iconSecondary" />
      <AppText style={styles.flex}>{text}</AppText>
      {onPress ? <Icon icon={ChevronRight} size="sm" color="iconSecondary" /> : null}
    </View>
  );
  if (!onPress)
    return (
      <View testID="today-shopping" accessible accessibilityLabel={text}>
        {inner}
      </View>
    );
  return (
    <Pressable testID="today-shopping" accessibilityRole="button" accessibilityLabel={text} accessibilityHint={hint} onPress={onPress} style={({ pressed }) => pressedStyle(pressed)}>
      {inner}
    </Pressable>
  );
}

/** The section label above a card («На сегодня · 3 из 4»): `sectionLabel`, no caps. */
export function SectionLabel({ title, value }: { title: string; value?: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { paddingHorizontal: theme.space[1], marginTop: theme.space[4], marginBottom: theme.space[2], gap: theme.space[2] }]}>
      <AppText variant="sectionLabel" accessibilityRole="header" style={styles.flex}>
        {title}
      </AppText>
      {value ? <AppText variant="callout">{value}</AppText> : null}
    </View>
  );
}

/** A list card of the day: rows without borders, inset dividers. */
export function DayCard({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Card testID={testID} padded={false} style={styles.clip}>
      {children}
    </Card>
  );
}

/**
 * «На страницах»: ≤2 tiles (only with the `today.tiles` switch, Ф-42), one column at ≥150%; each opens its page;
 * «⋯» (a quiet icon) pins or hides it in a kit sheet.
 */
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
    <View testID="today-tiles">
      <SectionLabel title={t('today.on_pages')} />
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[2] }}>
        {tiles.map((tile) => {
          const p = pageOf(tile.pageId);
          const name = nameOf(tile);
          return (
            <Card key={tile.pageId} padded={false} style={theme.largeFont ? undefined : styles.flex}>
              <Pressable
                testID={`today-tile-${tile.pageId}`}
                accessibilityRole="button"
                accessibilityLabel={`${name}. ${tile.text}`}
                accessibilityHint={t('pages.open')}
                onPress={() => router.navigate({ pathname: '/page/[id]', params: { id: tile.pageId } })}
                style={({ pressed }) => [{ padding: theme.space[3], paddingRight: theme.size.minTouch, gap: theme.space[1] }, pressedStyle(pressed)]}
              >
                <View style={[styles.row, { gap: theme.space[2] }]}>
                  {p ? <PageIcon name={p.icon} color={theme.colors.brand} size={20} /> : null}
                  <AppText variant="callout" color="ink2" style={styles.flex}>
                    {name}
                  </AppText>
                </View>
                <AppText variant="headline">{tile.text}</AppText>
              </Pressable>
              <Pressable
                testID={`today-tile-menu-${tile.pageId}`}
                accessibilityRole="button"
                accessibilityLabel={t('today.tile_menu_a11y', { page: name })}
                onPress={() => setMenu(tile)}
                hitSlop={hitSlopFor(theme.size.minTouch)}
                style={[styles.tileMenu, { width: theme.size.minTouch, height: theme.size.minTouch }]}
              >
                <Icon icon={Ellipsis} size="sm" color="iconSecondary" />
              </Pressable>
            </Card>
          );
        })}
      </View>
      <Sheet testID="tile-sheet" visible={menu !== null} onClose={() => setMenu(null)} title={menu ? nameOf(menu) : undefined}>
        {menu ? (
          <ActionList
            actions={[
              {
                key: 'pin',
                testID: 'tile-pin',
                icon: menu.pinned ? PinOff : Pin,
                label: menu.pinned ? t('today.tile_unpin') : t('today.tile_pin'),
                onPress: () => {
                  setMenu(null);
                  if (menuPage) void setTodayTile(menuPage, menu.pinned ? 'auto' : 'pinned');
                },
              },
              {
                key: 'hide',
                testID: 'tile-hide',
                icon: EyeOff,
                label: t('today.tile_hide'),
                onPress: () => {
                  setMenu(null);
                  if (menuPage) void setTodayTile(menuPage, 'hidden');
                },
              },
            ]}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  struck: { textDecorationLine: 'line-through' },
  clip: { overflow: 'hidden' },
  tileMenu: { position: 'absolute', top: 0, right: 0, alignItems: 'center', justifyContent: 'center' },
});
