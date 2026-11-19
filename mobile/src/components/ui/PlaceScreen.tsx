import { ChevronLeft } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type FlatListProps,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { feedAskScroll, InTabsContext, useChrome } from '@/store/chrome';
import { askBar, MAX_FONT_SCALE, onPlace, sheet as S, useTheme, type LayoutMetrics, type PlaceKey, type Theme } from '@/theme';

import { AppText } from '../AppText';
import type { LucideIcon } from './Icon';
import { pressedStyle, useReducedMotion } from './motion';

/**
 * v5 «Листы» screen (design-system §11.1, §11.4): the dark tray, two strips of neighbour places peeking (tab roots),
 * the coloured sheet of the place with its meta line, phrase or title, and under it — overlapping by 28 — the paper
 * sheet with the details, which scrolls.
 *
 * Collapse (like the iOS large title): the scroll moves the paper over the sheet 1:1, the sheet shrinks with it down
 * to the 44 dp strip (back or short date · title · 1–2 icons); after release it settles in one of the two states.
 * `mode="strip"`: second-level screens open with the strip already (note, category, receipt, settings, document).
 * Phrase: only where given and not `titleOnly` (≤ 340 dp or font ≥ 1.3), ≤ 2 lines.
 */
export type SheetAction = { key: string; icon: LucideIcon; label: string; onPress: () => void; testID?: string };
export type SheetBack = { label: string; onPress: () => void; testID?: string };

export type PlaceScreenProps = {
  place: PlaceKey;
  /** The screen name: the title (or the strip title when there is a phrase). */
  title: string;
  /** The line above the title («Вторник, 17 ноября», «128 заметок»). */
  meta?: string;
  /** Short form of the meta for the strip («вт, 17 нояб.», «128»). */
  stripMeta?: string;
  /** The big phrase (Geologica, ≤ 2 lines): only «Сегодня» and «Расходы». */
  phrase?: string;
  /** A line under the title (`sub`). */
  sub?: string;
  /** More on the sheet under the title (a search field, the big number). */
  sheetExtra?: ReactNode;
  /**
   * QA v5-device-3 J1: the height of `sheetExtra` in dp, known from tokens (the week, the big number). With it the sheet
   * height is right on the first frame; without it the paper waits for the first measure (hidden, never a jump).
   */
  sheetExtraHeight?: number;
  /** Replaces the meta line's text (e.g. a month picker). */
  metaNode?: ReactNode;
  back?: SheetBack;
  /** ≤ 2 round icons on the right. */
  actions?: SheetAction[];
  /** The two neighbour places peeking above the sheet (tab roots only). */
  peek?: readonly [PlaceKey, PlaceKey];
  /** `bare`: no coloured sheet, only the paper (screens without a header). */
  mode?: 'expanded' | 'strip' | 'bare';
  /** A control in the sheet's top row, before the icons (a toggle, «+ Трата»). */
  accessory?: ReactNode;
  /** The expanded sheet shows no title (it is in the strip): «Расходы» carry the big number instead. */
  hideTitle?: boolean;
  /** The strip's left / right slots instead of back · icons (the chat: «История» · 🔍 / ☁). */
  stripLeft?: ReactNode;
  stripRight?: ReactNode;
  /** testID of the coloured sheet (tests look for `page-header`). */
  headerTestID?: string;
  /** Scrolls (default) or a fixed paper (the chat, voice). */
  scroll?: boolean;
  children: ReactNode;
  /** Pinned at the bottom of the paper (outside the scroll): «Новый документ». */
  footer?: ReactNode;
  /** Paper background: `paper` (default) or `paper2` (the A4 desk). */
  paperTone?: 'paper' | 'paper2';
  /** Side padding of the paper (default the gutter). */
  paperPadding?: number;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
  titleTestID?: string;
  scrollRef?: React.Ref<SV>;
  onScroll?: ScrollViewProps['onScroll'];
  onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
  refreshControl?: ScrollViewProps['refreshControl'];
  /** The assistant strip lies over this screen: room for it at the end of the list + the 34 dp fade. */
  askRoom?: boolean;
};

type SV = React.ComponentRef<typeof ScrollView>;

/**
 * The sheet geometry (QA v5-device-1 A1–A4), pure for tests: the colour fills H − 28; the first element of the paper
 * starts 18 below the visible paper edge, i.e. at H − 28 + 18 of the scroll; content that fits once collapsed does
 * not keep the sheet collapsed.
 */
export function sheetInset(sheetHeight: number): number {
  return sheetHeight - S.overlap + S.paperPadTop;
}
export function sheetFits(contentHeight: number, viewportHeight: number, collapseRange: number): boolean {
  return contentHeight <= viewportHeight + collapseRange + 1;
}

/** Height of a text line in dp at the system font scale, capped like the `Text` that draws it. */
export const scaledLine = (lineHeight: number, fontScale: number, cap: number = MAX_FONT_SCALE) =>
  lineHeight * Math.min(fontScale, cap);

/**
 * QA v5-device-3 J1 / §4.1: the expanded sheet height from the tokens, BEFORE the first frame (never from `onLayout`):
 * padTop + the top row + the phrase (its lines are ours: `\n`, §11.4) or the title + `sub` + the extra + padBottom.
 * Pure for tests; `PlaceScreen` only checks it against the measure (dev warning past 1 dp).
 */
export function expandedSheetHeight(o: {
  m: LayoutMetrics;
  back?: boolean;
  /** A meta line or a meta node (both 1 line). */
  meta?: boolean;
  /** Lines of the shown phrase (0: no phrase). */
  phraseLines?: number;
  /** The title is drawn (not hidden into the strip). */
  title?: boolean;
  sub?: boolean;
  extra?: number;
}): number {
  const { m } = o;
  const fs = m.fontScale;
  const row = Math.max(S.topRow, o.back ? 48 : 0, o.meta ? scaledLine(18, fs) : 0, o.back ? scaledLine(20, fs) : 0);
  let body = 0;
  if (o.phraseLines && o.phraseLines > 0) body += 4 + o.phraseLines * scaledLine(Math.round(m.phraseSize * 1.12), fs, m.heroMaxScale);
  else if (o.title) body += 2 + scaledLine(m.largeText ? 40 : 34, fs, 1.2);
  if (o.sub) body += 4 + scaledLine(20, fs);
  body += o.extra ?? 0;
  return Math.ceil(S.padTop + row + body + m.sheetPadBottom);
}

/** Lines of a phrase as we wrap it ourselves (at most 2). */
export function phraseLines(phrase: string | undefined): number {
  if (!phrase) return 0;
  return Math.min(2, phrase.split('\n').length);
}

/** Last measured sheet heights by content: a revisited screen starts at its real height even where the tokens guess. */
const measuredSheets = new Map<string, number>();

/**
 * A screen whose list is its own (a FlatList of a page tool) makes THAT list the scroll of the sheet: the list asks
 * `usePlaceList(scrollTo)` for the top inset and the scroll handlers. Without a list asking, the paper is static.
 */
type PlaceListApi = {
  /** Space above the first row: the sheet minus the overlap, plus the paper's top padding. */
  inset: number;
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollEndDrag: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onMomentumScrollEnd: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  register: (scrollTo: (y: number, animated: boolean) => void) => () => void;
};
const PlaceListContext = createContext<PlaceListApi | null>(null);

export type PlaceListProps = {
  inset: number;
  onScroll: PlaceListApi['onScroll'];
  onScrollEndDrag: PlaceListApi['onScrollEndDrag'];
  onMomentumScrollEnd: PlaceListApi['onMomentumScrollEnd'];
  scrollEventThrottle: number;
};

/** For a list inside a `PlaceScreen scroll={false}`: null outside one (the list then scrolls on its own). */
export function usePlaceList(scrollTo: (y: number, animated: boolean) => void): PlaceListProps | null {
  const api = useContext(PlaceListContext);
  const fn = useRef(scrollTo);
  useEffect(() => {
    fn.current = scrollTo;
  });
  useEffect(() => (api ? api.register((y, a) => fn.current(y, a)) : undefined), [api]);
  if (!api) return null;
  return {
    inset: api.inset,
    onScroll: api.onScroll,
    onScrollEndDrag: api.onScrollEndDrag,
    onMomentumScrollEnd: api.onMomentumScrollEnd,
    scrollEventThrottle: 16,
  };
}

/** Hand the inner ScrollView to the caller's ref (object or callback). */
function assignRef(ref: React.Ref<SV> | undefined, value: SV | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref && typeof ref === 'object') (ref as React.RefObject<SV | null>).current = value;
}

function placeColors(theme: Theme, place: PlaceKey) {
  return { bg: theme.colors.place[place], ...onPlace(theme.colors, place) };
}

/** Round 40 icon on a sheet, 48 target. */
export function SheetIcon({
  icon: Cmp,
  label,
  onPress,
  color,
  testID,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  color: string;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      // A 40 dp circle to the eye, a 48 dp target (the margins keep the 40 dp layout of the mock).
      style={({ pressed }) => [
        styles.icon,
        { width: 48, height: 48, margin: -(48 - S.iconButton) / 2, borderRadius: 24 },
        pressedStyle(pressed),
      ]}
    >
      <Cmp size={22} color={color} strokeWidth={theme.icon.strokeWidth} />
    </Pressable>
  );
}

/** «‹ Заметки»: 600 16 (17 / 700 on terracotta: no small text there), chevron 22. */
export function SheetBackButton({
  back,
  color,
  strip,
  place,
}: {
  back: SheetBack;
  color: string;
  strip?: boolean;
  place: PlaceKey;
}) {
  const theme = useTheme();
  const big = place === 'assistant';
  return (
    <Pressable
      testID={back.testID ?? 'header-back'}
      accessibilityRole="button"
      accessibilityLabel={back.label}
      onPress={back.onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.back,
        { minHeight: theme.size.minTouch, marginLeft: strip ? 0 : -8 },
        pressedStyle(pressed),
      ]}
    >
      <ChevronLeft size={22} color={color} strokeWidth={theme.icon.strokeWidth} />
      <AppText
        numberOfLines={1}
        style={{
          color,
          fontFamily: big ? theme.type.button.fontFamily : theme.type.sheetMeta.fontFamily,
          fontSize: big ? 17 : strip ? 15 : 16,
          lineHeight: 20,
        }}
      >
        {back.label}
      </AppText>
    </Pressable>
  );
}

/** Two strips of the neighbour places above the sheet (dark: darker, brightness .62). */
export function StackPeek({ places }: { places: readonly [PlaceKey, PlaceKey] }) {
  const theme = useTheme();
  const dim = theme.scheme === 'dark' ? 'rgba(0,0,0,0.38)' : null;
  return (
    <View
      style={{ height: S.peek }}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {places.map((p, i) => (
        <View
          key={p + i}
          style={[
            styles.peek,
            i === 0 ? { left: 40, right: 40, top: 0 } : { left: 22, right: 22, top: 7 },
            { backgroundColor: theme.colors.place[p] },
          ]}
        >
          {i === 1 ? <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.06)' }]} /> : null}
          {dim ? <View style={[StyleSheet.absoluteFill, { backgroundColor: dim }]} /> : null}
        </View>
      ))}
    </View>
  );
}

/** The paper's rounded top over the coloured sheet: the sheet colour outside two quarter circles of radius 28. */
function PaperCorners({ color }: { color: string }) {
  const r = S.radius;
  return (
    <View pointerEvents="none" style={[styles.corners, { height: r }]}>
      <Svg width={r} height={r}>
        <Path d={`M0 0 H${r} A${r} ${r} 0 0 0 0 ${r} Z`} fill={color} />
      </Svg>
      <Svg width={r} height={r}>
        <Path d={`M${r} 0 H0 A${r} ${r} 0 0 1 ${r} ${r} Z`} fill={color} />
      </Svg>
    </View>
  );
}

/** `#RRGGBB` → the same colour at alpha 0 (a gradient to plain `transparent` greys out on Android). */
export function clearOf(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}00` : 'transparent';
}

/**
 * The fade at the bottom of the paper under the assistant strip (transparent → paper at 50 %, as before). QA
 * v5-device-3 L1: one native gradient, not an SVG layer over the scrolling content.
 */
export function BottomPaperFade({ color, height }: { color: string; height: number }) {
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[clearOf(color), color, color]}
      locations={[0, 0.5, 1]}
      style={[styles.fade, { height }]}
    />
  );
}

/** The paper's rounded bottom over the tray (two quarter circles in the tray colour) instead of a full-screen clip. */
function TrayCorners({ color }: { color: string }) {
  const r = S.radius;
  return (
    <View pointerEvents="none" style={[styles.corners, { height: r }]}>
      <Svg width={r} height={r}>
        <Path d={`M0 0 A${r} ${r} 0 0 0 ${r} ${r} H0 Z`} fill={color} />
      </Svg>
      <Svg width={r} height={r}>
        <Path d={`M${r} 0 A${r} ${r} 0 0 1 0 ${r} H${r} Z`} fill={color} />
      </Svg>
    </View>
  );
}

export function PlaceScreen({
  place,
  title,
  meta,
  stripMeta,
  phrase,
  sub,
  sheetExtra,
  sheetExtraHeight,
  metaNode,
  back,
  actions = [],
  peek,
  mode = 'expanded',
  scroll = true,
  children,
  footer,
  paperTone = 'paper',
  paperPadding,
  contentContainerStyle,
  testID,
  titleTestID,
  scrollRef,
  onScroll,
  onContentSizeChange,
  refreshControl,
  askRoom = false,
  accessory,
  headerTestID,
  stripLeft,
  stripRight,
  hideTitle = false,
}: PlaceScreenProps) {
  const theme = useTheme();
  const m = theme.m;
  const reduced = useReducedMotion();
  const c = placeColors(theme, place);
  const inTabs = useContext(InTabsContext);
  const tabBarHeight = useChrome((s) => s.tabBarHeight);
  const bottomRoom = inTabs ? tabBarHeight : Math.max(m.insets.bottom, 8);
  const paperBg = paperTone === 'paper2' ? theme.colors.paper2 : theme.colors.paper;
  const collapsedH = m.collapsedSheet;
  const showPhrase = !!phrase && !m.titleOnly;
  const strip = mode === 'strip';
  const bare = mode === 'bare';

  // QA v5-device-3 J1: the expanded height is computed from the tokens before the first frame. The measure only
  // corrects what the tokens cannot know (a title that wraps, an extra without a height) and is remembered by content.
  const extraKnown = !sheetExtra || sheetExtraHeight !== undefined;
  const estimate = expandedSheetHeight({
    m,
    back: !!back,
    meta: !!(meta || metaNode),
    phraseLines: showPhrase ? phraseLines(phrase) : 0,
    title: !showPhrase && !hideTitle,
    sub: !!sub,
    extra: sheetExtraHeight ?? 0,
  });
  const sheetKey = [
    place,
    title,
    showPhrase ? phrase : '',
    sub ?? '',
    !!back,
    !!(meta || metaNode),
    hideTitle,
    sheetExtraHeight ?? (sheetExtra ? '?' : '-'),
    m.width,
    m.fontScale,
    theme.scheme,
  ].join('|');
  const [measured, setMeasured] = useState<{ key: string; h: number } | null>(null);
  const known = measured?.key === sheetKey ? measured.h : measuredSheets.get(sheetKey);
  const expandedH = known ?? estimate;
  // Unknown yet (an extra without a height, never measured): the paper waits one frame rather than jump (J1 п. 2).
  const ready = strip || bare || extraKnown || known !== undefined;
  const H = bare ? S.overlap : strip ? collapsedH : Math.max(expandedH, collapsedH);
  const range = Math.max(1, H - collapsedH);
  const [y] = useState(() => new Animated.Value(0));
  const [collapsedState, setCollapsed] = useState(strip);
  // A screen that turns into a strip after loading (the record) is collapsed whatever it was before.
  const collapsed = strip || collapsedState;
  const innerRef = useRef<SV | null>(null);
  const viewport = useRef({ h: 0, content: 0 });
  /** The last scroll offset JS heard (the scroll listener): the collapsed flag and the reset on a page change. */
  const offset = useRef(0);

  // QA v5-device-1 A3/A4: another page in the same screen (tabs reuse it) starts expanded at the top — the sheet must
  // never stay collapsed from an old scroll. Only on a page change (QA v5-device-3 J2), never on a re-render.
  useEffect(() => {
    if (offset.current === 0) return;
    offset.current = 0;
    y.setValue(0);
    setCollapsed(false);
  }, [title, y]);

  const onSheetLayout = (e: LayoutChangeEvent) => {
    const h = Math.ceil(S.padTop + e.nativeEvent.layout.height + m.sheetPadBottom);
    measuredSheets.set(sheetKey, h);
    if (__DEV__ && extraKnown && Math.abs(h - estimate) > 1) {
      console.warn(`PlaceScreen «${title}»: the sheet measured ${h} dp, the tokens said ${estimate} dp`);
    }
    if (Math.abs(h - expandedH) > 1 || !ready) setMeasured({ key: sheetKey, h });
  };

  const setRef = (r: SV | null) => {
    innerRef.current = r;
    assignRef(scrollRef, r);
  };

  // After release: settle in one of the two states (200 ms snap).
  const external = useRef<((y: number, animated: boolean) => void) | null>(null);
  const [hasList, setHasList] = useState(false);
  // The handlers read the latest values through a ref, so their identity stays (QA v5-device-3 J2: a new handler on
  // every render re-attached the native scroll event and re-registered the list, which reset the sheet mid-scroll).
  const live = useRef({ strip, bare, range, reduced, askRoom, onScroll });
  useEffect(() => {
    live.current = { strip, bare, range, reduced, askRoom, onScroll };
  });
  const settle = useMemo(
    () =>
      (e: NativeSyntheticEvent<NativeScrollEvent>, drag = false) => {
        const L = live.current;
        if (L.strip || L.bare) return;
        const n = e.nativeEvent;
        // QA v5-device-2 A6: the snap waits for the fling to end — a scrollTo during the momentum made the sheet jump.
        if (drag && Math.abs(n.velocity?.y ?? 0) > 0.05) return;
        const at = n.contentOffset.y;
        // QA A4: content that fits once the sheet is collapsed is not a reason to collapse — it goes back expanded.
        const fits = sheetFits(n.contentSize.height, n.layoutMeasurement.height, L.range);
        if (at > 0 && (at < L.range || fits)) {
          const to = fits || at < L.range / 2 ? 0 : L.range;
          if (external.current) external.current(to, !L.reduced);
          else innerRef.current?.scrollTo({ y: to, animated: !L.reduced });
        }
      },
    [],
  );

  // A6/A7: the sheet follows the scroll on the UI thread (native driver, transforms and opacity only — no layout
  // and no setState per frame); JS only hears the scroll for the strip rules and the collapsed flag (a re-render only
  // when it flips; nothing the list depends on changes with it).
  const handleScroll = useMemo(
    () =>
      // The listener reads the refs only when a scroll event comes, never during render.
      // eslint-disable-next-line react-hooks/refs
      Animated.event([{ nativeEvent: { contentOffset: { y } } }], {
        useNativeDriver: true,
        listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
          const L = live.current;
          const n = e.nativeEvent;
          offset.current = n.contentOffset.y;
          if (!L.strip && !L.bare) {
            const next = n.contentOffset.y >= L.range / 2;
            setCollapsed((was) => (was === next ? was : next));
          }
          if (L.askRoom) feedAskScroll(n.contentOffset.y, n.contentSize.height, n.layoutMeasurement.height);
          L.onScroll?.(e);
        },
      }),
    [y],
  );
  const onScrollEndDrag = useMemo(() => (e: NativeSyntheticEvent<NativeScrollEvent>) => settle(e, true), [settle]);
  const onMomentumScrollEnd = useMemo(() => (e: NativeSyntheticEvent<NativeScrollEvent>) => settle(e), [settle]);

  // The sheet keeps its full height H and slides up by the scroll (clamped to the range): its bottom edge moves 1:1 with
  // the paper, the top row (the strip, the rounded cap) slides back down by the same amount, so it stays in place.
  const shift = strip ? 0 : y.interpolate({ inputRange: [0, range], outputRange: [0, range], extrapolate: 'clamp' });
  const lift = strip ? 0 : y.interpolate({ inputRange: [0, range], outputRange: [0, -range], extrapolate: 'clamp' });
  const sheetH = strip ? collapsedH : H;
  // B1: the phrase, the week and the big number are gone by 60 % of the way, the strip title comes from 70 %.
  const fullOpacity = y.interpolate({ inputRange: [0, range * 0.6], outputRange: [1, 0], extrapolate: 'clamp' });
  const stripOpacity = strip
    ? 1
    : y.interpolate({ inputRange: [range * 0.7, range], outputRange: [0, 1], extrapolate: 'clamp' });

  const icons = (
    <View style={styles.row}>
      {actions.slice(0, 3).map((a) => (
        <SheetIcon key={a.key} icon={a.icon} label={a.label} onPress={a.onPress} color={c.ink} testID={a.testID} />
      ))}
    </View>
  );

  const pad = paperPadding ?? m.gutter;
  const askPad = askRoom ? m.ask.listBottomPadding : 0;
  const inset = sheetInset(H);
  // QA v5-device-3 J2: one api per sheet geometry. `register` does not reset the scroll of a list that keeps scrolling:
  // only a list that comes in under a sheet JS last heard scrolled (a list swapped on the same page) starts expanded.
  const listApi = useMemo<PlaceListApi>(
    () => ({
      inset,
      onScroll: handleScroll as unknown as PlaceListApi['onScroll'],
      onScrollEndDrag,
      onMomentumScrollEnd,
      register: (fn) => {
        external.current = fn;
        if (offset.current !== 0) {
          offset.current = 0;
          y.setValue(0);
          setCollapsed(false);
        }
        setHasList(true);
        return () => {
          if (external.current === fn) {
            external.current = null;
            setHasList(false);
          }
        };
      },
    }),
    [inset, handleScroll, onScrollEndDrag, onMomentumScrollEnd, y],
  );
  const listMode = !scroll && hasList;
  // QA v5-device-3 L1: every area is painted once — the paper by its one container (or the list backdrop), never
  // again by the body.
  const body = (
    <View
      style={[
        {
          paddingHorizontal: pad,
          paddingTop: listMode ? 0 : S.paperPadTop,
          paddingBottom: (scroll ? theme.space[6] : 0) + (listMode ? 0 : askPad),
        },
        scroll ? null : styles.flex,
        contentContainerStyle,
      ]}
    >
      {children}
    </View>
  );
  const hidden = ready ? null : styles.hidden;

  return (
    <View
      testID={testID}
      // L1: in the tabs the tray is the root's (the stack screen behind); elsewhere (a modal) the screen brings its own.
      style={[styles.flex, { paddingTop: m.top, paddingBottom: bottomRoom }, inTabs ? null : { backgroundColor: theme.colors.tray }]}
    >
      {peek ? <StackPeek places={peek} /> : null}
      <View style={styles.flex}>
        {scroll ? (
          <Animated.ScrollView
            ref={setRef}
            testID={testID ? `${testID}-scroll` : undefined}
            style={[styles.flex, hidden]}
            bounces={false}
            overScrollMode="never"
            scrollEventThrottle={16}
            onScroll={handleScroll}
            onScrollEndDrag={onScrollEndDrag}
            onMomentumScrollEnd={onMomentumScrollEnd}
            onLayout={(e: LayoutChangeEvent) => (viewport.current.h = e.nativeEvent.layout.height)}
            onContentSizeChange={(w: number, h: number) => {
              viewport.current.content = h;
              onContentSizeChange?.(w, h);
            }}
            refreshControl={refreshControl}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ flexGrow: 1, paddingTop: H - S.overlap }}
          >
            <View style={[styles.grow, { backgroundColor: paperBg }]}>{body}</View>
          </Animated.ScrollView>
        ) : (
          <PlaceListContext.Provider value={listApi}>
            {listMode ? (
              // The paper behind the list: from the collapsed sheet's edge down (the sheet covers the rest above), so
              // it needs no transform and nothing reaches past the screen.
              <View
                pointerEvents="none"
                style={[styles.backdrop, hidden, { top: collapsedH - S.overlap, backgroundColor: paperBg }]}
              />
            ) : null}
            <View
              style={[
                styles.flex,
                hidden,
                listMode ? null : { marginTop: H - S.overlap, backgroundColor: paperBg },
              ]}
            >
              {body}
            </View>
          </PlaceListContext.Provider>
        )}
        {footer ? (
          <View
            style={{ backgroundColor: paperBg, paddingHorizontal: pad, paddingBottom: 14, paddingTop: theme.space[2] }}
          >
            {footer}
          </View>
        ) : null}
        {askRoom ? <BottomPaperFade color={paperBg} height={askBar.bottomFade} /> : null}
        {/* The paper's rounded bottom corners (were a clip of the whole screen). */}
        <TrayCorners color={theme.colors.tray} />

        {/* The coloured sheet over the scroll; its bottom 28 dp are the paper's rounded corners. */}
        {bare ? (
          <View pointerEvents="none" style={[styles.sheet, { height: S.overlap }]}>
            <PaperCorners color={theme.colors.tray} />
          </View>
        ) : (
          <Animated.View
            pointerEvents="box-none"
            nativeID="v5-sheet"
            testID={headerTestID ?? (testID ? `${testID}-sheet` : 'place-sheet')}
            style={[styles.sheet, { height: sheetH, transform: [{ translateY: lift }] }]}
          >
            {/* QA v5-device-1 A1: the colour fills only down to the paper's edge (H − 28); the last 28 dp are the two
              rounded corners of the paper (a mask in the sheet colour), the middle shows the paper itself. */}
            <View
              pointerEvents="none"
              style={[styles.fill, { top: S.radius, bottom: S.overlap, backgroundColor: c.bg }]}
            />
            {/* The rounded top of the sheet stays at the top while the sheet slides up under it. */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.cap,
                {
                  height: 2 * S.radius,
                  backgroundColor: c.bg,
                  borderTopLeftRadius: S.radius,
                  borderTopRightRadius: S.radius,
                  transform: [{ translateY: shift }],
                },
              ]}
            />
            {strip ? null : (
              <Animated.View
                pointerEvents={collapsed ? 'none' : 'box-none'}
                importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}
                accessibilityElementsHidden={collapsed}
                onLayout={onSheetLayout}
                style={[styles.full, { top: S.padTop, paddingHorizontal: m.gutter, opacity: fullOpacity }]}
              >
                <View style={[styles.row, { minHeight: S.topRow, gap: 6 }]}>
                  {back ? <SheetBackButton back={back} color={c.ink} place={place} /> : null}
                  <View style={styles.flex}>
                    {metaNode ??
                      (meta ? (
                        <AppText variant="sheetMeta" numberOfLines={1} style={{ color: c.ink2 }}>
                          {meta}
                        </AppText>
                      ) : null)}
                  </View>
                  {accessory}
                  {icons}
                </View>
                {showPhrase ? (
                  <AppText
                    testID="sheet-phrase"
                    numberOfLines={2}
                    nativeID="v5-capped"
                    maxFontSizeMultiplier={m.heroMaxScale}
                    accessibilityRole="header"
                    style={[
                      theme.type.phrase,
                      {
                        color: c.ink,
                        fontSize: m.phraseSize,
                        lineHeight: Math.round(m.phraseSize * 1.12),
                        letterSpacing: -0.025 * m.phraseSize,
                        marginTop: 4,
                        maxWidth: 13.5 * m.phraseSize,
                      },
                    ]}
                  >
                    {phrase}
                  </AppText>
                ) : hideTitle ? (
                  // The name stays for screen readers (the strip shows it once collapsed).
                  <AppText testID={titleTestID} accessibilityRole="header" style={styles.srOnly}>
                    {title}
                  </AppText>
                ) : (
                  <AppText
                    testID={titleTestID}
                    accessibilityRole="header"
                    style={[
                      theme.type.title,
                      {
                        color: c.ink,
                        marginTop: 2,
                        fontSize: m.largeText ? 36 : 30,
                        lineHeight: m.largeText ? 40 : 34,
                      },
                    ]}
                    nativeID="v5-capped"
                    maxFontSizeMultiplier={1.2}
                  >
                    {title}
                  </AppText>
                )}
                {sub ? (
                  <AppText variant="sheetMeta" style={{ color: c.ink2, marginTop: 4, lineHeight: 20 }}>
                    {sub}
                  </AppText>
                ) : null}
                {sheetExtra}
              </Animated.View>
            )}

            <Animated.View
              pointerEvents={collapsed ? 'box-none' : 'none'}
              importantForAccessibility={collapsed ? 'auto' : 'no-hide-descendants'}
              accessibilityElementsHidden={!collapsed}
              style={[
                styles.strip,
                {
                  top: S.stripPadTop,
                  minHeight: S.strip,
                  paddingHorizontal: 10,
                  opacity: stripOpacity,
                  transform: [{ translateY: shift }],
                },
              ]}
            >
              <View style={[styles.side, styles.left]}>
                {stripLeft ? (
                  stripLeft
                ) : back ? (
                  <SheetBackButton back={back} color={c.ink} strip place={place} />
                ) : stripMeta ? (
                  <AppText
                    variant="caption"
                    numberOfLines={1}
                    style={{ color: c.ink2, fontFamily: theme.type.sheetMeta.fontFamily, paddingLeft: 8 }}
                  >
                    {stripMeta}
                  </AppText>
                ) : null}
              </View>
              <AppText
                testID={strip ? titleTestID : undefined}
                accessibilityRole="header"
                numberOfLines={1}
                nativeID="v5-capped"
                maxFontSizeMultiplier={1.3}
                style={[theme.type.stripTitle, styles.stripTitle, { color: c.ink }]}
              >
                {title}
              </AppText>
              <View style={[styles.side, styles.right]}>{stripRight ?? icons}</View>
            </Animated.View>

            <PaperCorners color={c.bg} />
          </Animated.View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  icon: { alignItems: 'center', justifyContent: 'center' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 },
  peek: { position: 'absolute', height: 30, borderTopLeftRadius: 18, borderTopRightRadius: 18, overflow: 'hidden' },
  sheet: { position: 'absolute', left: 0, right: 0, top: 0 },
  full: { position: 'absolute', left: 0, right: 0 },
  cap: { position: 'absolute', left: 0, right: 0, top: 0 },
  strip: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  side: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  left: { justifyContent: 'flex-start' },
  right: { justifyContent: 'flex-end' },
  stripTitle: { textAlign: 'center', flexShrink: 1, maxWidth: '50%' },
  corners: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  backdrop: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  fill: { position: 'absolute', left: 0, right: 0, top: 0 },
  srOnly: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  hidden: { opacity: 0 },
});

/**
 * A FlatList that is the scroll of its `PlaceScreen scroll={false}` (the sheet collapses with it). Outside one it is
 * a plain FlatList.
 */
export function PlaceFlatList<T>(props: FlatListProps<T>) {
  const ref = useRef<FlatList<T>>(null);
  const place = usePlaceList((y, animated) => ref.current?.scrollToOffset({ offset: y, animated }));
  const { contentContainerStyle, onScroll, onScrollEndDrag, onMomentumScrollEnd, ...rest } = props;
  return (
    <AnimatedList
      ref={ref}
      {...rest}
      scrollEventThrottle={16}
      onScroll={place ? place.onScroll : onScroll}
      onScrollEndDrag={(e) => {
        place?.onScrollEndDrag(e);
        onScrollEndDrag?.(e);
      }}
      onMomentumScrollEnd={(e) => {
        place?.onMomentumScrollEnd(e);
        onMomentumScrollEnd?.(e);
      }}
      contentContainerStyle={[contentContainerStyle, place ? { paddingTop: place.inset } : null]}
    />
  );
}

/** A FlatList that takes the native scroll event of the sheet (`usePlaceList().onScroll`). */
export const AnimatedList = Animated.FlatList as unknown as typeof FlatList;
