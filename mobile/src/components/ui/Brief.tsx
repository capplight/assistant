import { ChevronRight } from 'lucide-react-native';
import { Children, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { gridItemWidth, useLayout, useTheme } from '@/theme';

import { AppText } from '../AppText';
import { cardEdge } from './Card';
import { Glass } from './Glass';
import { Icon, type LucideIcon } from './Icon';
import { pressedStyle } from './motion';

/** The 8 status dot with the `brandGlow` (one of the four glowing things, design-system v2 §4). */
export function StatusDot({ color }: { color?: string }) {
  const theme = useTheme();
  const c = color ?? theme.colors.brand;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c, shadowColor: c, shadowOpacity: 0.9, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } }}
    />
  );
}

/** A 4 dp progress bar on the `track`. */
export function ProgressBar({ value, color, testID }: { value: number; color: string; testID?: string }) {
  const theme = useTheme();
  const v = Math.max(0, Math.min(1, value));
  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v * 100) }}
      style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.track, overflow: 'hidden' }}
    >
      <View style={{ width: `${v * 100}%`, height: 4, borderRadius: 2, backgroundColor: color }} />
    </View>
  );
}

/**
 * BriefCard (design-system v2 §5, p14): `surface`, radius 26, padding 18. A status line — glowing dot + `eyebrow`
 * in `brand` («ДОБРОЕ УТРО · 5 ДЕЛ») — then the `briefHeadline` and the `briefBody` summary in `ink2`, at most
 * 3 lines with «Подробнее ›» (opens the whole text in place). `children`: a budget bar and its labels.
 */
export function BriefCard({
  status,
  headline,
  body,
  more,
  children,
  testID,
}: {
  status: string;
  headline: string;
  body?: string;
  more?: string;
  children?: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <Glass
      testID={testID}
      style={[
        { backgroundColor: theme.scheme === 'dark' ? undefined : theme.colors.surface, borderRadius: theme.radius.xxl, padding: theme.space[4] + 2, gap: theme.space[2] },
        theme.elevation.card,
        cardEdge(theme),
      ]}
    >
      <View style={[styles.row, { gap: theme.space[2] }]}>
        <StatusDot />
        <AppText testID={testID ? `${testID}-status` : undefined} variant="eyebrow" color="brand" style={styles.flex}>
          {status}
        </AppText>
      </View>
      <AppText testID={testID ? `${testID}-headline` : undefined} variant="briefHeadline" accessibilityRole="header">
        {headline}
      </AppText>
      {body ? (
        // ≤3 lines + «Подробнее» (the sums in it are never cut: at a large font the whole text shows).
        <AppText testID={testID ? `${testID}-body` : undefined} variant="briefBody" color="ink2" numberOfLines={open || theme.largeFont ? undefined : 3}>
          {body}
        </AppText>
      ) : null}
      {children}
      {more && body && !open && !theme.largeFont ? (
        <Pressable
          testID={testID ? `${testID}-more` : undefined}
          accessibilityRole="button"
          onPress={() => setOpen(true)}
          style={({ pressed }) => [styles.row, { alignSelf: 'flex-start', minHeight: theme.size.minTouch - 8, gap: 2 }, pressedStyle(pressed)]}
        >
          <AppText variant="callout" color="brand" style={{ fontFamily: theme.type.button.fontFamily }}>
            {more}
          </AppText>
          <Icon icon={ChevronRight} size="sm" color="brand" />
        </Pressable>
      ) : null}
    </Glass>
  );
}

/**
 * MetricTile (design-system v2 §5): `eyebrow` label + chevron, the `metric` number in the tile's colour with its
 * `metricUnit`, a `footnote` caption, an optional 4 dp progress bar. Min 132 high, radius 22. A tap opens the section.
 * CategoryTile = the same with an `icon` in a coloured circle and a title above the number.
 */
export function MetricTile({
  label,
  title,
  value,
  unit,
  caption,
  color,
  progress,
  icon,
  iconTint,
  captionColor,
  onPress,
  testID,
}: {
  label?: string;
  title?: string;
  value: string;
  unit?: string;
  caption?: string;
  color: string;
  progress?: number | null;
  icon?: LucideIcon;
  iconTint?: string;
  captionColor?: 'danger' | 'ink2';
  onPress?: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  const box = [
    {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.size.metricTile.radius,
      minHeight: theme.size.metricTile.minHeight,
      padding: theme.space[3] + 2,
      gap: theme.space[1],
    },
    theme.elevation.card,
    cardEdge(theme),
  ];
  const a11y = [label ?? title, `${value}${unit ? ` ${unit}` : ''}`, caption].filter(Boolean).join('. ');
  const content = (
    <>
      <View style={[styles.row, { gap: theme.space[2] }]}>
        {icon ? (
          <View style={[styles.circle, { width: 32, height: 32, borderRadius: 16, backgroundColor: iconTint ?? theme.colors.brandTint }]}>
            <Icon icon={icon} size="sm" color={color} />
          </View>
        ) : (
          <AppText variant="eyebrow" color="ink2" style={styles.flex}>
            {label}
          </AppText>
        )}
        {icon ? <View style={styles.flex} /> : null}
        {onPress ? <Icon icon={ChevronRight} size="sm" color="iconSecondary" /> : null}
      </View>
      {title ? (
        <AppText variant="callout" color="ink2" style={{ marginTop: theme.space[2] }}>
          {title}
        </AppText>
      ) : null}
      <View style={[styles.baseline, { gap: 4, marginTop: title ? 0 : theme.space[1] }]}>
        <AppText variant="metric" style={{ color }}>
          {value}
        </AppText>
        {unit ? (
          <AppText variant="metricUnit" style={{ color }}>
            {unit}
          </AppText>
        ) : null}
      </View>
      {caption ? (
        <AppText variant="footnote" color={captionColor ?? 'ink2'}>
          {caption}
        </AppText>
      ) : null}
      <View style={styles.flex} />
      {progress !== undefined && progress !== null ? <ProgressBar value={progress} color={color} /> : null}
    </>
  );
  if (!onPress)
    return (
      <View testID={testID} accessible accessibilityLabel={a11y} style={box}>
        {content}
      </View>
    );
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={a11y} onPress={onPress} style={({ pressed }) => [...box, pressedStyle(pressed)]}>
      {content}
    </Pressable>
  );
}

/**
 * Tiles 2×2 with a gap of 8 (design-system v2 §6): 4 columns from 600, one column under 360 dp and at ≥150 %.
 * Measures its own width like `ResponsiveGrid`.
 */
export function TileGrid({ children, testID }: { children: ReactNode; testID?: string }) {
  const layout = useLayout();
  const [width, setWidth] = useState(layout.contentWidth);
  const items = Children.toArray(children);
  const n = layout.width < 360 || layout.largeFont ? 1 : layout.widthClass === 'expanded' ? Math.min(4, items.length) : 2;
  const gap = 8;
  const w = gridItemWidth(width, n, gap);
  const onLayout = (e: LayoutChangeEvent) => {
    const next = Math.round(e.nativeEvent.layout.width);
    if (next > 0 && next !== width) setWidth(next);
  };
  return (
    <View testID={testID} onLayout={onLayout} style={[styles.grid, { gap }]}>
      {items.map((c, i) => (
        <View key={i} style={{ width: n === 1 ? '100%' : w }}>
          {c}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  baseline: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' },
  flex: { flex: 1 },
  circle: { alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch' },
});
