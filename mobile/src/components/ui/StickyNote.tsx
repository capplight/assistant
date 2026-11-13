import { Pin } from 'lucide-react-native';
import { Children, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type AccessibilityActionEvent, type AccessibilityActionInfo, type LayoutChangeEvent } from 'react-native';

import { gridItemWidth, useLayout, useTheme, type NoteColorKey } from '@/theme';

import { AppText } from '../AppText';
import { Icon } from './Icon';
import { pressedStyle } from './motion';

type NoteProps = {
  text: string;
  title?: string;
  /** One meta line (`footnote` ink3), e.g. the date. */
  date?: string;
  color?: NoteColorKey;
  pinned?: boolean;
  onPress?: () => void;
  /** The menu opens on long press — no «⋯» on the card (design-system §3 StickyNote). */
  onLongPress?: () => void;
  accessibilityLabel?: string;
  /** Screen-reader actions (Выше / Ниже / Ещё) — the doubles of the gestures. */
  accessibilityActions?: AccessibilityActionInfo[];
  onAccessibilityAction?: (e: AccessibilityActionEvent) => void;
  /** Just changed by the assistant: `highlightTint` for 600 ms. */
  highlighted?: boolean;
  /** Small extra lines under the text (status, the AI label, «Проверить»). */
  children?: ReactNode;
  testID?: string;
};

/**
 * A sticker: the note colour as fill (`white` = surface + card shadow), radius 14, padding 12, title `headline`,
 * text `callout` up to 8 lines (a preview of the person's own note; the full text opens on tap), date `footnote`.
 */
export function StickyNote({
  text,
  title,
  date,
  color = 'yellow',
  pinned,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityActions,
  onAccessibilityAction,
  highlighted,
  children,
  testID,
}: NoteProps) {
  const theme = useTheme();
  const white = color === 'white';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [title, text, date].filter(Boolean).join('. ')}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      delayLongPress={400}
      style={({ pressed }) => [
        { backgroundColor: highlighted ? theme.colors.highlightTint : theme.notes[color], borderRadius: theme.radius.md, padding: theme.space[3], gap: theme.space[1] },
        white ? theme.elevation.card : null,
        pressedStyle(pressed),
      ]}
    >
      {title || pinned ? (
        <View style={styles.head}>
          {title ? (
            <AppText variant="headline" style={styles.flex}>
              {title}
            </AppText>
          ) : (
            <View style={styles.flex} />
          )}
          {pinned ? <Icon testID={testID ? `${testID}-pin` : undefined} icon={Pin} size="sm" color="brand" /> : null}
        </View>
      ) : null}
      <AppText variant="callout" color="ink" numberOfLines={8}>
        {text}
      </AppText>
      {children}
      {date ? (
        <AppText variant="footnote" color={white ? 'ink3' : 'ink2'}>
          {date}
        </AppText>
      ) : null}
    </Pressable>
  );
}

type GridProps = {
  children: ReactNode;
  /** Fixed columns; default: `useLayout().noteColumns` (2 · 3 from 600 · 1 at ≥150 %, 1 under 360 from 130 %). */
  columns?: number;
  gap?: number;
  testID?: string;
};

/**
 * Responsive grid for stickers and tiles: items in rows of `columns`, each `gridItemWidth` wide. Measures its
 * own width (starts from the layout's content width) so it is right inside two panes and sheets too.
 */
export function ResponsiveGrid({ children, columns, gap = 8, testID }: GridProps) {
  const layout = useLayout();
  const [width, setWidth] = useState(layout.contentWidth);
  const n = Math.max(1, columns ?? layout.noteColumns);
  const w = gridItemWidth(width, n, gap);
  const onLayout = (e: LayoutChangeEvent) => {
    const next = Math.round(e.nativeEvent.layout.width);
    if (next > 0 && next !== width) setWidth(next);
  };
  // Masonry-light: column-major so tall notes do not leave holes under short ones in the same row.
  const cols: ReactNode[][] = Array.from({ length: n }, () => []);
  Children.toArray(children).forEach((c, i) => cols[i % n]!.push(c));
  return (
    <View testID={testID} onLayout={onLayout} style={[styles.grid, { gap }]}>
      {cols.map((items, i) => (
        <View key={i} style={{ width: n === 1 ? '100%' : w, gap }}>
          {items}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  flex: { flex: 1 },
  // wrap: widths already add up; it only tells the 200% audit this is a grid, not a row of buttons.
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
});
