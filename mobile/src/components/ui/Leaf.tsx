import { ChevronRight } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { sheet, useTheme, type PlaceKey } from '@/theme';

import { AppText } from '../AppText';
import { pressedStyle } from './motion';

/**
 * Small v5 «Листы» primitives (screens-v5.html): the place tab, the category square, the one big number, a section
 * head, a list row, an inset block, a switch and a progress bar. Sizes come from the theme (`sheet`, `theme.m`).
 */

/** `.ptab`: 16 × 22 tab in the colour of a place at the start of a row (search, «Ещё», «История», trash). */
export function PlaceTab({ place, style }: { place: PlaceKey; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View
      testID={`place-tab-${place}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width: sheet.placeTab.width, height: sheet.placeTab.height, borderTopLeftRadius: 5, borderTopRightRadius: 5, borderBottomLeftRadius: 2, borderBottomRightRadius: 2, backgroundColor: theme.colors.place[place] },
        style,
      ]}
    />
  );
}

/** `.kq`: the 12 dp square in a category colour — the only place a category colour appears (never a background). */
export function CategorySquare({ color, ring }: { color: string; ring?: string }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width: sheet.categorySquare, height: sheet.categorySquare, borderRadius: 4, backgroundColor: color }, ring ? { borderWidth: 1.5, borderColor: ring } : null]}
    />
  );
}

/** `.big`: ONE per screen — Geologica 700 46, tabular, «₸» at 0.56 of the size. */
export function BigNumber({ value, currency, color, testID, size = 46 }: { value: string; currency?: string; color?: string; testID?: string; size?: number }) {
  const theme = useTheme();
  const c = color ?? theme.colors.ink;
  return (
    <AppText
      testID={testID}
      nativeID="v5-capped"
      maxFontSizeMultiplier={theme.m.heroMaxScale}
      style={[theme.type.bigNumber, { color: c, fontSize: size, lineHeight: Math.round(size * 1.08), letterSpacing: -0.035 * size }]}
    >
      {value}
      {currency ? <AppText style={{ fontSize: Math.round(size * 0.56), fontFamily: theme.type.bigNumber.fontFamily, color: c }}>{` ${currency}`}</AppText> : null}
    </AppText>
  );
}

/** `.sec`: 17 bold head with a link («Все дела ›») or a count on the right. 18 above, 6 below. */
export function SectionHead({
  title,
  right,
  link,
  onLink,
  linkTestID,
  first,
  testID,
}: {
  title: string;
  /** Muted count / sum on the right (`.m`). */
  right?: string;
  /** A link on the right with a chevron (`.lk`). */
  link?: string;
  onLink?: () => void;
  linkTestID?: string;
  first?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View testID={testID} style={[styles.sec, { marginTop: first ? 0 : 18, marginBottom: 6 }]}>
      <AppText variant="section" accessibilityRole="header" style={styles.flex}>
        {title}
      </AppText>
      {right !== undefined ? (
        <AppText variant="small" color="ink3" style={styles.tnum}>
          {right}
        </AppText>
      ) : null}
      {link ? (
        <Pressable testID={linkTestID} accessibilityRole="link" accessibilityLabel={link} onPress={onLink} hitSlop={12} style={({ pressed }) => [styles.lk, pressedStyle(pressed)]}>
          <AppText style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15, lineHeight: 18, fontVariant: ['tabular-nums'] }}>{link}</AppText>
          <ChevronRight size={15} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** `.ln`: a row of 54 (68 at large text) with a `line` on top (not on the first of a block). */
export function Row({
  children,
  first,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityRole,
  testID,
  style,
}: {
  children: ReactNode;
  first?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: 'button' | 'link' | 'checkbox';
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const box: StyleProp<ViewStyle> = [styles.row, { minHeight: theme.m.row, borderTopWidth: first ? 0 : 1, borderTopColor: theme.colors.line, gap: 12 }, style];
  if (!onPress && !onLongPress)
    return (
      <View testID={testID} style={box} accessibilityLabel={accessibilityLabel}>
        {children}
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [box, pressed ? { backgroundColor: theme.colors.paper2 } : null]}
    >
      {children}
    </Pressable>
  );
}

/** `.m`: the muted meta at the end of a row (ink3 14, tabular). */
export function RowMeta({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <AppText testID={testID} variant="small" color="ink3" style={styles.tnum}>
      {children}
    </AppText>
  );
}

/** A row's chevron (`ink3` 18). */
export function RowChevron() {
  const theme = useTheme();
  return <ChevronRight size={18} color={theme.colors.ink3} strokeWidth={theme.icon.strokeWidth} />;
}

/** The inset block on paper (`paper2`, radius 16, 12 / 14): banners, the «изменил помощник» plate. */
export function Inset({ children, style, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={[{ backgroundColor: theme.colors.paper2, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14 }, style]}>
      {children}
    </View>
  );
}

/** The v5 switch: 50 × 30, on = `btn` with an `onBtn` knob; off = a 2 `ink3` ring with an `ink3` knob. */
export function Toggle({ value, onChange, label, testID, disabled }: { value: boolean; onChange: (v: boolean) => void; label: string; testID?: string; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      hitSlop={9}
      onPress={() => onChange(!value)}
      style={[
        styles.toggle,
        value ? { backgroundColor: theme.colors.btn } : { borderWidth: 2, borderColor: theme.colors.ink3 },
        disabled ? { opacity: 0.4 } : null,
      ]}
    >
      <View
        style={
          value
            ? { position: 'absolute', right: 3, top: 3, width: 24, height: 24, borderRadius: 12, backgroundColor: theme.colors.onBtn }
            : { position: 'absolute', left: 3, top: 3, width: 20, height: 20, borderRadius: 10, backgroundColor: theme.colors.ink3 }
        }
      />
    </Pressable>
  );
}

/** A simple bar in the colour of the text (`line` track): import progress, a category against its budget. */
export function Bar({ value, color, height = 8, track, testID }: { value: number; color?: string; height?: number; track?: string; testID?: string }) {
  const theme = useTheme();
  const v = Math.max(0, Math.min(1, value));
  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }}
      style={{ height, borderRadius: height / 2, backgroundColor: track ?? theme.colors.line, overflow: 'hidden' }}
    >
      <View style={{ height: '100%', width: `${v * 100}%`, backgroundColor: color ?? theme.colors.ink, borderRadius: height / 2 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sec: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  lk: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center' },
  tnum: { fontVariant: ['tabular-nums'] },
  toggle: { width: 50, height: 30, borderRadius: 15 },
});
