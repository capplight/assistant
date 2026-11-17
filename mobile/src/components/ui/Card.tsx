import { ChevronRight } from 'lucide-react-native';
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, withAlpha, type Theme } from '@/theme';

import { AppText } from '../AppText';
import { Glass } from './Glass';
import { Icon, type LucideIcon } from './Icon';
import { pressedStyle } from './motion';

export type CardTone = 'surface' | 'raised' | 'sunken' | 'brandTint' | 'highlight';

function toneBg(theme: Theme, tone: CardTone): string {
  const c = theme.colors;
  return { surface: c.surface, raised: c.surfaceRaised, sunken: c.surfaceSunken, brandTint: c.brandTint, highlight: c.highlight }[tone];
}

/** v5: flat sheets — no rings or hairlines on cards. */
export function cardEdge(_theme: Theme): ViewStyle | null {
  return null;
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

/** v5 inset block (`paper2`, radius 16, flat): banners, progress, the receipt. Other tones map to v5 roles. */
export function Card({ children, tone = 'surface', padded = true, onPress, accessibilityLabel, style, testID }: CardProps) {
  const theme = useTheme();
  const base: StyleProp<ViewStyle> = [
    {
      backgroundColor: toneBg(theme, tone),
      borderRadius: 16,
      paddingVertical: padded ? 12 : 0,
      paddingHorizontal: padded ? 14 : 0,
    },
  ];
  const glass = false;
  if (!onPress)
    return glass ? (
      <Glass testID={testID} style={[base, style]}>
        {children}
      </Glass>
    ) : (
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
      style={({ pressed }) => [glass ? null : base, pressedStyle(pressed), glass ? null : style]}
    >
      {glass ? <Glass style={[base, style]}>{children}</Glass> : children}
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
  // v5 `.ln`: a plain 22 icon in `ink` (no tinted square).
  const lead = left ?? (icon ? <Icon icon={icon} size="md" color={danger ? 'danger' : 'ink'} /> : null);
  const body = (pressed: boolean) => (
    <View
      style={[
        styles.row,
        {
          minHeight: meta ? theme.size.rowHeightMeta : theme.m.row,
          gap: theme.space[3],
          backgroundColor: pressed ? withAlpha(theme.colors.paper2, 0.8) : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
        separator ? { borderBottomWidth: 1, borderBottomColor: theme.colors.line } : null,
      ]}
    >
      {lead}
      <View
        style={[
          styles.text,
          { paddingVertical: theme.space[2] },
        ]}
      >
        <View style={styles.flex}>
          <AppText color={danger ? 'danger' : 'ink'} style={danger ? { fontFamily: theme.type.bodyStrong.fontFamily } : null}>
            {title}
          </AppText>
          {meta ? <AppText variant="footnote">{meta}</AppText> : null}
        </View>
        {value !== undefined ? (
          <AppText variant="small" color="ink3" style={{ fontVariant: ['tabular-nums'] }}>
            {value}
          </AppText>
        ) : null}
        {right}
        {chevron ? <Icon icon={ChevronRight} size="sm" color="ink3" /> : null}
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


/** v5: rows straight on the paper, a `line` between them; the title is a section head (17 bold). */
export function ListGroup({ children, title, style, testID }: { children: ReactNode; title?: string; style?: StyleProp<ViewStyle>; testID?: string }) {
  const theme = useTheme();
  const rows = Children.toArray(children).filter(isValidElement) as ReactElement<ListRowProps>[];
  return (
    <View style={[{ gap: 6 }, style]} testID={testID}>
      {title ? (
        <AppText variant="section" accessibilityRole="header" style={{ marginTop: theme.space[3] }}>
          {title}
        </AppText>
      ) : null}
      <View>{rows.map((r, i) => (r.type === ListRow ? cloneElement(r, { separator: i < rows.length - 1 }) : r))}</View>
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
