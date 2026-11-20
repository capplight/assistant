import { ShoppingBag } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { pressedStyle } from '@/components/ui/motion';
import { currencySymbol, formatMinor } from '@/expenses/calc';
import { HERO_MAX_SCALE, todayTile, useTheme } from '@/theme';

export type SpentPart = { key: string; title: string; share: number; color: string };

/**
 * today-v6-acceptance.md §3.5 (Ф-94) — always two tiles side by side, equal width, gap 10, in every period: «Потрачено»
 * (today's sum by the person's day, the categories, a 6 dp bar) and «Купить» (the count, the first names). An empty tile
 * stays a tile («0 ₸», «Пусто» in `ink3`). Shopping off (Ф-49): the left tile keeps its half, the right is empty. Only
 * with a huge font on a narrow window the two stand one under the other (§8.2).
 */
export function TodayTiles({
  spentMinor,
  parts,
  toBuy,
  shopping,
  onSpent,
  onBuy,
}: {
  /** Today's spending in KZT minor units. */
  spentMinor: bigint;
  /** Categories of today, biggest first. */
  parts: SpentPart[];
  toBuy: string[];
  /** `features.shopping` (Ф-49). */
  shopping: boolean;
  onSpent: () => void;
  onBuy: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const c = theme.colors;
  const stacked = theme.fontScale >= todayTile.stackFrom && theme.m.width < todayTile.stackBelowWidth;
  const sym = currencySymbol('KZT');
  const amount = formatMinor(spentMinor > 0n ? spentMinor : 0n).replace(` ${sym}`, '');
  const spent = spentMinor > 0n;
  const label = (text: string, mark: ReactNode) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {mark}
      <AppText numberOfLines={1} style={{ flexShrink: 1, fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 13, lineHeight: 16, color: c.ink2 }}>
        {text}
      </AppText>
    </View>
  );
  const big = (text: ReactNode, empty: boolean, testID: string) => (
    <AppText
      testID={testID}
      nativeID="v5-capped"
      maxFontSizeMultiplier={HERO_MAX_SCALE}
      style={{
        marginTop: 4,
        fontFamily: theme.type.title.fontFamily,
        fontSize: todayTile.amount,
        lineHeight: 28,
        letterSpacing: -0.4,
        fontVariant: ['tabular-nums'],
        color: empty ? c.ink3 : c.ink,
      }}
    >
      {text}
    </AppText>
  );
  const sub = (text: string, testID: string) => (
    <AppText testID={testID} numberOfLines={2} style={{ fontSize: 13, lineHeight: 17, color: c.ink3 }}>
      {text}
    </AppText>
  );
  const tile = { flex: stacked ? undefined : 1, minWidth: 0, minHeight: todayTile.minHeight, borderRadius: todayTile.radius, backgroundColor: c.paper2, paddingVertical: todayTile.pad.v, paddingHorizontal: todayTile.pad.h, gap: 3 } as const;
  const names = toBuy.slice(0, 6).map((x) => x.toLocaleLowerCase());

  return (
    <View testID="today-tiles" style={{ flexDirection: stacked ? 'column' : 'row', gap: todayTile.gap, marginTop: 20 }}>
      <Pressable
        testID="today-tile-spent"
        accessibilityRole="button"
        accessibilityLabel={spent ? t('today6.tile_spent_a11y', { sum: amount }) : t('today6.tile_spent_none_a11y')}
        onPress={onSpent}
        style={({ pressed }) => [tile, pressedStyle(pressed)]}
      >
        {label(t('today6.tile_spent'), <View style={{ width: 12, height: 16, borderRadius: 3, backgroundColor: c.place.expenses }} />)}
        {big(
          <>
            {spent ? amount : '0'}
            <AppText style={{ fontSize: todayTile.amount * 0.6, color: spent ? c.ink : c.ink3 }}>{` ${sym}`}</AppText>
          </>,
          !spent,
          'today-tile-spent-sum',
        )}
        {sub(spent ? parts.map((p) => p.title).join(', ') : t('today6.tile_spent_none'), 'today-tile-spent-sub')}
        <View
          testID="today-tile-spent-bar"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ flexDirection: 'row', height: todayTile.bar, borderRadius: todayTile.bar / 2, overflow: 'hidden', gap: 2, marginTop: 'auto' }}
        >
          {spent && parts.length > 0 ? (
            parts.map((p) => <View key={p.key} style={{ flex: Math.max(p.share, 1), backgroundColor: p.color }} />)
          ) : (
            <View style={{ flex: 1, backgroundColor: c.line }} />
          )}
        </View>
      </Pressable>
      {shopping ? (
        <Pressable
          testID="today-tile-buy"
          accessibilityRole="button"
          accessibilityLabel={toBuy.length > 0 ? t('today6.tile_buy_a11y', { n: toBuy.length, items: names.slice(0, 3).join(', ') }) : t('today6.tile_buy_empty_a11y')}
          onPress={onBuy}
          style={({ pressed }) => [tile, pressedStyle(pressed)]}
        >
          {label(t('today6.tile_buy'), <ShoppingBag size={15} color={c.ink2} strokeWidth={theme.icon.strokeWidth} />)}
          {big(toBuy.length > 0 ? String(toBuy.length) : t('today6.tile_buy_empty'), toBuy.length === 0, 'today-tile-buy-count')}
          {sub(toBuy.length > 0 ? names.join(', ') : t('today6.tile_buy_hint'), 'today-tile-buy-sub')}
        </Pressable>
      ) : stacked ? null : (
        <View testID="today-tile-blank" style={{ flex: 1 }} />
      )}
    </View>
  );
}
