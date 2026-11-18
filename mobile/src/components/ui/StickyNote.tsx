import { Pin } from 'lucide-react-native';
import { Children, useState, type ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type LayoutChangeEvent,
} from 'react-native';

import Svg, { Path } from 'react-native-svg';

import {
  gridItemWidth,
  noteInk,
  STICKER_KEYS,
  stickerOf,
  useLayout,
  useTheme,
  type StickerColor,
  type StickerKey,
} from '@/theme';

import { AppText } from '../AppText';
import { Icon } from './Icon';
import { pressedStyle } from './motion';

type NoteProps = {
  text: string;
  title?: string;
  /** One meta line (`footnote` ink3), e.g. the date. */
  date?: string;
  color?: StickerColor;
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
  /** Ф-73 «изменил помощник» (24 h): a thin `brand` 50 % ring with a soft glow (design-system §10.3). */
  changed?: boolean;
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
export function autoNoteColor(seed: string): StickerKey {
  // Ф-85: one of the 7 pastels (never paper, never a place hue); the wall itself uses the round (`roundStickerColors`).
  const fills = STICKER_KEYS.filter((k) => k !== 'paper');
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return fills[h % fills.length]!;
}

/**
 * A sticker v5 (screens-v5 `.stk`): the sticker colour as fill (old keys through `legacyStickerMap`; «бумага» has a
 * 1 `line` edge), radius 20, padding 14; grid: title 16/700, text 14 `stickerInk.ink2`, date 13; list: title 17.
 * Changed by the assistant: the 24 terracotta fold in the top right corner (no glow).
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
  changed,
  children,
  look = 'grid',
  testID,
}: NoteProps) {
  const theme = useTheme();
  const white = stickerOf(color) === 'paper';
  const ink = noteInk[theme.scheme];
  const list = look === 'list';
  const titleStyle = list
    ? { fontFamily: theme.type.headline.fontFamily, fontSize: 17, lineHeight: 22, color: ink.ink }
    : { fontFamily: theme.type.headline.fontFamily, fontSize: 16, lineHeight: 20, color: ink.ink };
  const textStyle = list
    ? { fontSize: 15, lineHeight: 21, color: ink.ink2 }
    : { fontSize: 14, lineHeight: 20, color: ink.ink2 };
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
          backgroundColor: theme.notes[color],
          borderRadius: 20,
          // QA v5-device-2 A4 (`stickerLayout`): a list card is 16 / 14 and at least 64 high.
          paddingTop: 14,
          paddingHorizontal: list ? 16 : 14,
          paddingBottom: list ? 14 : 13,
          minHeight: list ? 64 : undefined,
          gap: 4,
          overflow: 'hidden',
        },
        white ? { borderWidth: 1, borderColor: theme.colors.line } : null,
        // A new / found sticker is ringed in terracotta for a moment (the assistant put it here).
        highlighted ? { borderWidth: 2, borderColor: theme.colors.place.assistant } : null,
        pressedStyle(pressed),
      ]}
    >
      {changed ? (
        <Fold
          paper={theme.colors.paper}
          color={theme.colors.place.assistant}
          testID={testID ? `${testID}-changed` : undefined}
        />
      ) : null}
      {title || pinned ? (
        <View style={styles.head}>
          {title ? (
            <AppText variant="headline" style={[styles.flex, titleStyle]}>
              {title}
            </AppText>
          ) : (
            <View style={styles.flex} />
          )}
          {pinned && !list ? (
            <Icon testID={testID ? `${testID}-pin` : undefined} icon={Pin} size="sm" color={ink.ink2} />
          ) : null}
        </View>
      ) : null}
      <View style={list ? styles.listBody : undefined}>
        <AppText variant="callout" numberOfLines={list ? 2 : 6} style={[textStyle, list ? styles.flex : null]}>
          {text}
        </AppText>
        {pinned && list ? (
          <Icon testID={testID ? `${testID}-pin` : undefined} icon={Pin} size="sm" color={ink.ink2} />
        ) : null}
      </View>
      {children}
      {/* B6: the date is the last line, at the left, in both looks. */}
      {dateText}
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

/** The 24 dp «изменил помощник» fold: a terracotta corner under a paper triangle. */
function Fold({ paper, color, testID }: { paper: string; color: string; testID?: string }) {
  return (
    <View testID={testID} pointerEvents="none" style={styles.fold}>
      <Svg width={24} height={24}>
        <Path d="M0 0 H24 V24 Z" fill={paper} />
        <Path d="M0 0 L24 24 H8 A8 8 0 0 1 0 16 Z" fill={color} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  fold: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: 24,
    height: 24,
    borderTopRightRadius: 20,
    overflow: 'hidden',
    zIndex: 1,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  listBody: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  flex: { flex: 1 },
  // wrap: widths already add up; it only tells the 200% audit this is a grid, not a row of buttons.
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
});
