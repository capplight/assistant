import { ChevronRight } from 'lucide-react-native';
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, withAlpha, type Theme } from '@/theme';

import { AppText } from '../AppText';
import { Icon, type LucideIcon } from './Icon';
import { pressedStyle } from './motion';

export type CardTone = 'surface' | 'raised' | 'sunken' | 'brandTint' | 'highlight';

function toneBg(theme: Theme, tone: CardTone): string {
  const c = theme.colors;
  return { surface: c.surface, raised: c.surfaceRaised, sunken: c.surfaceSunken, brandTint: c.brandTint, highlight: c.highlight }[tone];
}

type CardProps = {
  children: ReactNode;
  tone?: CardTone;
  /** 16 inside by default; `false` for a list group whose rows pad themselves. */
  padded?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** `surface`, radius 16, the `card` shadow (none in the dark theme), no borders (design-system §3 Card). */
export function Card({ children, tone = 'surface', padded = true, onPress, accessibilityLabel, style, testID }: CardProps) {
  const theme = useTheme();
  const base: StyleProp<ViewStyle> = [
    {
      backgroundColor: toneBg(theme, tone),
      borderRadius: tone === 'highlight' ? theme.radius.xl : theme.radius.lg,
      padding: padded ? theme.space[4] : 0,
    },
    tone === 'surface' ? theme.elevation.card : null,
  ];
  if (!onPress)
    return (
      <View testID={testID} style={[base, style]}>
        {children}
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [base, pressedStyle(pressed), style]}
    >
      {children}
    </Pressable>
  );
}

type ListRowProps = {
  title: string;
  /** Second line, `callout` ink2. */
  meta?: string;
  /** An icon (20–24) or a square with a sign / a check on the left. */
  left?: ReactNode;
  /** Lucide icon on the left, in a 30 square of `brandTint` («Ещё»). */
  icon?: LucideIcon;
  /** A value on the right (`number`), or any node. */
  value?: string;
  right?: ReactNode;
  /** Chevron `iconSecondary` on the right. */
  chevron?: boolean;
  /** «Удалить»: title in `danger`. */
  danger?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** Set by `ListGroup`: the last row has no divider. */
  separator?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: 'button' | 'link' | 'checkbox' | 'radio' | 'none';
  selected?: boolean;
  testID?: string;
};

/**
 * 52 (64 with meta), 12–14 left padding, title `body`, meta `callout` ink2, inset 0.5 divider; pressed =
 * `surfaceSunken` 50 % (design-system §3 ListRow). Text wraps, never cut.
 */
export function ListRow({
  title,
  meta,
  left,
  icon,
  value,
  right,
  chevron,
  danger,
  onPress,
  onLongPress,
  disabled,
  separator = false,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole,
  selected,
  testID,
}: ListRowProps) {
  const theme = useTheme();
  const lead =
    left ??
    (icon ? (
      <View style={[styles.square, { backgroundColor: theme.colors.brandTint, borderRadius: theme.radius.sm }]}>
        <Icon icon={icon} size="sm" color={danger ? 'danger' : 'brand'} />
      </View>
    ) : null);
  const body = (pressed: boolean) => (
    <View
      style={[
        styles.row,
        {
          minHeight: meta ? theme.size.rowHeightMeta : theme.size.rowHeight,
          paddingLeft: theme.space[3] + 2,
          paddingRight: theme.space[3],
          gap: theme.space[3],
          backgroundColor: pressed ? withAlpha(theme.colors.surfaceSunken, 0.5) : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      {lead}
      <View
        style={[
          styles.text,
          { paddingVertical: theme.space[2] + 2 },
          separator ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.separator } : null,
        ]}
      >
        <View style={styles.flex}>
          <AppText color={danger ? 'danger' : 'ink'}>{title}</AppText>
          {meta ? <AppText variant="callout">{meta}</AppText> : null}
        </View>
        {value !== undefined ? (
          <AppText variant="number" color="ink2">
            {value}
          </AppText>
        ) : null}
        {right}
        {chevron ? <Icon icon={ChevronRight} size="sm" color="iconSecondary" /> : null}
      </View>
    </View>
  );
  if (!onPress && !onLongPress)
    return (
      <View testID={testID} accessibilityLabel={accessibilityLabel}>
        {body(false)}
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityLabel={accessibilityLabel ?? (meta ? `${title}. ${meta}` : title)}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}


/** A card of rows: inset dividers between rows, none after the last one. */
export function ListGroup({ children, title, style, testID }: { children: ReactNode; title?: string; style?: StyleProp<ViewStyle>; testID?: string }) {
  const theme = useTheme();
  const rows = Children.toArray(children).filter(isValidElement) as ReactElement<ListRowProps>[];
  return (
    <View style={[{ gap: theme.space[2] }, style]} testID={testID}>
      {title ? (
        <AppText variant="sectionLabel" color="ink2" accessibilityRole="header" style={{ paddingHorizontal: theme.space[1] }}>
          {title}
        </AppText>
      ) : null}
      <Card padded={false} style={styles.clip}>
        {rows.map((r, i) => (r.type === ListRow ? cloneElement(r, { separator: i < rows.length - 1 }) : r))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'stretch' },
  flex: { flex: 1 },
  square: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  clip: { overflow: 'hidden' },
});
