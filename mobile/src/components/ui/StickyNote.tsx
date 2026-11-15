import { Pin } from 'lucide-react-native';
import { Children, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type AccessibilityActionEvent, type AccessibilityActionInfo, type LayoutChangeEvent } from 'react-native';

import { gridItemWidth, NOTE_COLOR_KEYS, noteInk, useLayout, useTheme, type NoteColorKey } from '@/theme';

import { cardEdge } from './Card';

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
  /** v2: `grid` (masonry cell) or `list` (full width: title 17, text 15, the date on the right — easier for elders). */
  look?: 'grid' | 'list';
  testID?: string;
};

/**
 * A note nobody coloured still shows in one of the 7 colours (Ф-52 «разноцветные, как в макете»): picked from its id,
 * so it keeps its colour; the person's own choice always wins. Display only — nothing is saved.
 */
export function autoNoteColor(seed: string): NoteColorKey {
  const fills = NOTE_COLOR_KEYS.filter((k) => k !== 'white');
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return fills[h % fills.length]!;
}

/**
 * A sticker v2 (design-system §5 StickyNote v2): the note colour as fill (`white` = surface + card shadow and ring),
 * radius 18, padding 12; grid: title 15/700, text 14 up to 8 lines, date 12; list: title 17, text 15, the date top
 * right. Text is `noteInk` on every fill (a preview of the person's own note; the full text opens on tap).
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
  look = 'grid',
  testID,
}: NoteProps) {
  const theme = useTheme();
  const white = color === 'white';
  const ink = noteInk[theme.scheme];
  const list = look === 'list';
  const titleStyle = list
    ? { fontFamily: theme.type.headline.fontFamily, fontSize: 17, lineHeight: 22, color: ink.ink }
    : { fontFamily: theme.type.sectionLabel.fontFamily, fontSize: 15, lineHeight: 20, color: ink.ink };
  const textStyle = list ? { fontSize: 15, lineHeight: 20, color: ink.ink } : { fontSize: 14, lineHeight: 19, color: ink.ink };
  const dateText = date ? (
    <AppText variant="caption" style={{ color: ink.ink2, fontFamily: theme.type.footnote.fontFamily }}>
      {date}
    </AppText>
  ) : null;
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
        {
          backgroundColor: highlighted ? theme.colors.highlightTint : theme.notes[color],
          borderRadius: theme.radius.lg,
          padding: theme.space[3],
          paddingHorizontal: list ? theme.space[4] : theme.space[3],
          gap: theme.space[1],
        },
        white ? theme.elevation.card : null,
        white ? cardEdge(theme) : null,
        pressedStyle(pressed),
      ]}
    >
      {title || pinned || (list && date) ? (
        <View style={styles.head}>
          {title ? (
            <AppText variant="headline" style={[styles.flex, titleStyle]}>
              {title}
            </AppText>
          ) : (
            <View style={styles.flex} />
          )}
          {list && date ? dateText : null}
          {pinned && !list ? <Icon testID={testID ? `${testID}-pin` : undefined} icon={Pin} size="sm" color={ink.ink2} /> : null}
        </View>
      ) : null}
      <View style={list ? styles.listBody : undefined}>
        <AppText variant="callout" numberOfLines={list ? 3 : 6} style={[textStyle, list ? styles.flex : null]}>
          {text}
        </AppText>
        {pinned && list ? <Icon testID={testID ? `${testID}-pin` : undefined} icon={Pin} size="sm" color={ink.ink2} /> : null}
      </View>
      {children}
      {!list ? dateText : null}
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
  listBody: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  flex: { flex: 1 },
  // wrap: widths already add up; it only tells the 200% audit this is a grid, not a row of buttons.
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
});
