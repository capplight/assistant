import * as Haptics from 'expo-haptics';
import { Bell, Check } from 'lucide-react-native';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';

import { blockStates, endOf, windowAhead, type BlockState, type CalEntry } from '@/calendar/entries';
import {
  blockBox,
  blockX,
  dragDuration,
  dragStart,
  drawnSpan,
  GRID,
  gridHeight,
  halfHourOf,
  minuteAt,
  yOf,
} from '@/calendar/geometry';
import { layoutColumn } from '@/calendar/overlap';
import { hhmm, isoDate, minutesOf } from '@/calendar/time';
import { markFresh } from '@/components/ChangedMark';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { useReducedMotion } from '../ui/motion';
import { durText } from './parts';

/**
 * The hour grid of «День» / «3 дня» (calendar-time.md §3–§4, calendar-time.html A0–A4): one ScrollView, the lines and
 * labels painted once (one SVG), blocks absolute (their coming never moves the grid), every position from `geometry`.
 * Gestures are Gesture Handler ones (recognised on the UI thread): a tap on empty time → a 1 h draft from the half
 * hour; a long press on empty time and a pull → a draft as long as the pull (15-min steps); a long press on a block
 * lifts it (×1.02, the old place outlined), a pull moves it in 15-min steps (the time shows in the time column), the
 * knob under a chosen block changes its length; a sideways swipe pages the days.
 */
export type GridDraft = { date: string; start: number; duration: number };
export type DropTo = { date: string; start: number; duration: number | null };

type Props = {
  dates: string[];
  entries: CalEntry[];
  now: number;
  width: number;
  viewport: number;
  initialY: number;
  /** A programmatic scroll (back to today, the assistant's block). */
  scrollTo: { y: number; seq: number } | null;
  ringKey: string | null;
  draft: GridDraft | null;
  dragEnabled: boolean;
  onEmpty: (d: GridDraft) => void;
  onOpen: (e: CalEntry) => void;
  onToggle: (e: CalEntry) => void;
  onDrop: (e: CalEntry, to: DropTo) => void;
  onMore: (keys: string[]) => void;
  onSwipe: (dir: -1 | 1) => void;
  onTouch?: () => void;
  testID?: string;
};

export function DayGrid(p: Props) {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const c = theme.colors;
  const cols = p.dates.length;
  const multi = cols > 1;
  const colW = (p.width - GRID.timeColumn) / cols;
  const today = isoDate(p.now);
  const nowMin = minutesOf(p.now);
  const todayCol = p.dates.indexOf(today);
  const H = gridHeight();
  const scrollRef = useRef<{ scrollTo: (o: { y: number; animated: boolean }) => void } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragLabel, setDragLabel] = useState<number | null>(null);
  const [drawing, setDrawing] = useState<(GridDraft & { press: number }) | null>(null);

  useEffect(() => {
    if (p.scrollTo) scrollRef.current?.scrollTo({ y: p.scrollTo.y, animated: !reduced });
  }, [p.scrollTo, reduced]);
  // A chosen block keeps its knob 4 s.
  useEffect(() => {
    if (!selected) return;
    const id = setTimeout(() => setSelected(null), 4000);
    return () => clearTimeout(id);
  }, [selected]);

  const timed = useMemo(() => p.entries.filter((e) => !e.allDay && e.start !== null), [p.entries]);
  const states = useMemo(() => blockStates(timed, p.now), [timed, p.now]);
  const win = !multi && p.dates[0] === today ? windowAhead(timed, p.now) : null;

  const layout = useMemo(() => {
    const out: { e: CalEntry; col: number; lane: number; lanes: number; narrow: boolean }[] = [];
    const more: { col: number; start: number; keys: string[] }[] = [];
    p.dates.forEach((d, col) => {
      const day = timed.filter((e) => e.date === d && e.kind !== 'reminder');
      const r = layoutColumn(day.map((e) => ({ key: e.key, start: e.start!, duration: e.duration })));
      const byKey = new Map(day.map((e) => [e.key, e]));
      for (const x of r.placed) out.push({ e: byKey.get(x.key)!, col, lane: x.lane, lanes: x.lanes, narrow: x.narrow });
      for (const m of r.more) more.push({ col, start: m.start, keys: m.keys });
    });
    return { out, more };
  }, [p.dates, timed]);
  const reminders = timed.filter((e) => e.kind === 'reminder');

  // --- empty time: tap → 1 h draft from the half hour; long press + pull → as long as the pull ---
  const colAt = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - GRID.timeColumn) / colW)));
  const tapAt = (x: number, y: number) => {
    if (x < GRID.timeColumn) return;
    p.onTouch?.();
    void Haptics.selectionAsync().catch(() => undefined);
    p.onEmpty({ date: p.dates[colAt(x)]!, start: halfHourOf(minuteAt(y)), duration: 60 });
  };
  const drawStart = (x: number, y: number) => {
    if (x < GRID.timeColumn) return;
    p.onTouch?.();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    const s = drawnSpan(minuteAt(y), 0);
    setDrawing({ date: p.dates[colAt(x)]!, start: s.start, duration: s.duration, press: minuteAt(y) });
  };
  const drawMove = (dy: number) => {
    setDrawing((d) => {
      if (!d) return d;
      const s = drawnSpan(d.press, dy);
      if (d.duration === s.duration) return d;
      void Haptics.selectionAsync().catch(() => undefined);
      return { ...d, duration: s.duration };
    });
  };
  const drawEnd = () => {
    setDrawing((d) => {
      if (d) p.onEmpty({ date: d.date, start: d.start, duration: d.duration });
      return null;
    });
  };
  const drawStep = useSharedValue(0);
  const emptyGesture = useMemo(() => {
    const tap = Gesture.Tap()
      .maxDuration(350)
      .onEnd((e, ok) => {
        if (ok) runOnJS(tapAt)(e.x, e.y);
      });
    const draw = Gesture.Pan()
      .enabled(p.dragEnabled)
      .activateAfterLongPress(400)
      .onStart((e) => {
        drawStep.set(0);
        runOnJS(drawStart)(e.x, e.y);
      })
      .onUpdate((e) => {
        const s = Math.round(e.translationY / 15);
        if (s !== drawStep.get()) {
          drawStep.set(s);
          runOnJS(drawMove)(e.translationY);
        }
      })
      .onEnd(() => runOnJS(drawEnd)());
    return Gesture.Exclusive(draw, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt with the days and widths it maps to
  }, [p.dates, colW, p.dragEnabled]);

  // --- sideways swipe: the grid follows the finger, 200 ms settle, then the next days ---
  const tx = useSharedValue(0);
  const fade = useSharedValue(1);
  const first = p.dates[0];
  useLayoutEffect(() => {
    tx.set(0);
    fade.set(0);
    fade.set(withTiming(1, { duration: reduced ? 150 : 180 }));
  }, [first, tx, fade, reduced]);
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-24, 24])
        .failOffsetY([-14, 14])
        .onUpdate((e) => {
          tx.set(reduced ? 0 : e.translationX);
        })
        .onEnd((e) => {
          const far = Math.abs(e.translationX) > p.width * 0.25 || Math.abs(e.velocityX) > 700;
          if (!far) {
            tx.set(withTiming(0, { duration: 200 }));
            return;
          }
          const dir = e.translationX < 0 ? 1 : -1;
          tx.set(withTiming(reduced ? 0 : -dir * p.width, { duration: 200 }, () => runOnJS(p.onSwipe)(dir as -1 | 1)));
        }),
    [p.width, p.onSwipe, tx, reduced],
  );
  const pageStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }], opacity: fade.value }));

  const onLift = (key: string) => {
    p.onTouch?.();
    setSelected(key);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
  };
  const onStep = (min: number | null) => {
    setDragLabel(min);
    if (min !== null) void Haptics.selectionAsync().catch(() => undefined);
  };
  const drop = (e: CalEntry, dx: number, dy: number, resize: boolean) => {
    setDragLabel(null);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    if (resize) {
      const d = dragDuration(e.start!, e.duration, dy);
      if (d !== e.duration) p.onDrop(e, { date: e.date, start: e.start!, duration: d });
      return;
    }
    const shift = multi ? Math.round(dx / colW) : 0;
    const col = Math.min(cols - 1, Math.max(0, p.dates.indexOf(e.date) + shift));
    const start = dragStart(e.start!, dy, e.duration);
    const date = p.dates[col] ?? e.date;
    if (start !== e.start || date !== e.date) p.onDrop(e, { date, start, duration: e.duration });
  };

  const lines = useMemo(() => <GridLines width={p.width} cols={cols} line={c.line} />, [p.width, cols, c.line]);
  const shown = drawing ?? p.draft;

  return (
    <GestureDetector gesture={swipe}>
      <Animated.View style={[styles.flex, pageStyle]}>
        <Animated.ScrollView
          ref={scrollRef as never}
          testID={p.testID ?? 'cal-grid'}
          style={styles.flex}
          contentOffset={{ x: 0, y: p.initialY }}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScrollBeginDrag={p.onTouch}
          contentContainerStyle={{ height: H + GRID.bottomRoom }}
          accessibilityLabel={t('cal.view_day')}
        >
          <View style={{ height: H }}>
            {/* Past time is shaded (paper2 at 55 %): today up to now, a past day whole. */}
            {p.dates.map((d, i) =>
              d < today || i === todayCol ? (
                <View
                  key={`past-${d}`}
                  pointerEvents="none"
                  style={[
                    styles.abs,
                    {
                      top: 0,
                      height: d < today ? H : yOf(nowMin),
                      left: multi ? GRID.timeColumn + colW * i : 0,
                      width: multi ? colW : p.width,
                      backgroundColor: c.paper2,
                      opacity: 0.55,
                    },
                  ]}
                />
              ) : null,
            )}
            {/* Screen readers: an invisible button per hour of empty time (§7). */}
            <EmptyHourButtons dates={p.dates} entries={timed} onAdd={(date, start) => p.onEmpty({ date, start, duration: 60 })} />
            <GestureDetector gesture={emptyGesture}>
              <View
                testID="cal-empty-layer"
                style={StyleSheet.absoluteFill}
                accessible={false}
              />
            </GestureDetector>
            {lines}
            <HourLabels nowMin={todayCol >= 0 ? nowMin : p.dates.every((d) => d < today) ? 1440 : -1} />
            {win ? (
              <WindowBlock
                top={yOf(win.start) + 2}
                height={Math.max(GRID.minBlock, win.end - win.start - 4)}
                label={t('cal.window', { time: durText(t, win.end - win.start) })}
                onPress={() => p.onEmpty({ date: today, start: Math.ceil(win.start / 15) * 15, duration: 60 })}
              />
            ) : null}
            {reminders.map((e) => {
              const col = p.dates.indexOf(e.date);
              if (col < 0) return null;
              const x = blockX({ width: p.width, col, cols, lane: 0, lanes: 1 });
              return <ReminderMark key={e.key} e={e} left={x.left} width={x.width} small={multi} onOpen={p.onOpen} />;
            })}
            {layout.out.map(({ e, col, lane, lanes, narrow }) => {
              const x = blockX({ width: p.width, col, cols, lane, lanes, narrow });
              return (
                <Block
                  key={e.key}
                  e={e}
                  state={states.get(e.key) ?? 'plain'}
                  now={p.now}
                  left={x.left}
                  width={x.width}
                  small={multi}
                  ring={p.ringKey === e.key}
                  selected={selected === e.key}
                  dragEnabled={p.dragEnabled && e.kind === 'task'}
                  onOpen={p.onOpen}
                  onToggle={p.onToggle}
                  onLift={onLift}
                  onStep={onStep}
                  onDrop={drop}
                />
              );
            })}
            {layout.more.map((m) => {
              const right = p.width - (GRID.timeColumn + colW * (m.col + 1)) + GRID.more.right;
              return (
                <Pressable
                  key={`more-${m.col}-${m.start}`}
                  testID={`cal-more-${m.start}`}
                  accessibilityRole="button"
                  accessibilityLabel={t('cal.more_a11y', { count: m.keys.length, time: hhmm(m.start) })}
                  onPress={() => p.onMore(m.keys)}
                  hitSlop={4}
                  style={[
                    styles.abs,
                    styles.center,
                    {
                      top: yOf(m.start) + 1,
                      height: GRID.more.height,
                      right,
                      width: GRID.more.width,
                      borderRadius: 12,
                      backgroundColor: c.paper,
                      borderWidth: 1.5,
                      borderColor: c.line2,
                    },
                  ]}
                >
                  <AppText style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 14, lineHeight: 16, color: c.ink }}>{`+${m.keys.length}`}</AppText>
                </Pressable>
              );
            })}
            {shown && p.dates.includes(shown.date) ? (
              <DraftBlock
                draft={shown}
                left={blockX({ width: p.width, col: p.dates.indexOf(shown.date), cols, lane: 0, lanes: 1 }).left}
                width={blockX({ width: p.width, col: p.dates.indexOf(shown.date), cols, lane: 0, lanes: 1 }).width}
              />
            ) : null}
            {todayCol >= 0 ? <NowLine nowMin={nowMin} /> : null}
            {dragLabel !== null ? (
              <View pointerEvents="none" style={[styles.abs, { left: 4, top: yOf(dragLabel) - 12, zIndex: 6, backgroundColor: c.ink, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 5 }]}>
                <AppText testID="cal-drag-time" style={{ color: c.paper, fontFamily: theme.type.title.fontFamily, fontSize: 13, lineHeight: 14, fontVariant: ['tabular-nums'] }}>
                  {hhmm(dragLabel)}
                </AppText>
              </View>
            ) : null}
          </View>
        </Animated.ScrollView>
      </Animated.View>
    </GestureDetector>
  );
}

/** Hour lines (`line` 1) and dashed half hours, the column separators of «3 дня»: one static picture. */
const GridLines = memo(function GridLines({ width, cols, line }: { width: number; cols: number; line: string }) {
  const H = gridHeight();
  const colW = (width - GRID.timeColumn) / cols;
  return (
    <Svg pointerEvents="none" width={width} height={H} style={StyleSheet.absoluteFill}>
      {Array.from({ length: 25 }, (_, h) => (
        <Line key={`h${h}`} x1={GRID.timeColumn} x2={width} y1={yOf(h * 60) + 0.5} y2={yOf(h * 60) + 0.5} stroke={line} strokeWidth={1} />
      ))}
      {Array.from({ length: 24 }, (_, h) => (
        <Line key={`m${h}`} x1={GRID.timeColumn} x2={width} y1={yOf(h * 60 + 30) + 0.5} y2={yOf(h * 60 + 30) + 0.5} stroke={line} strokeWidth={1} strokeDasharray="4 3" />
      ))}
      {Array.from({ length: Math.max(0, cols - 1) }, (_, i) => (
        <Line key={`v${i}`} x1={GRID.timeColumn + colW * (i + 1) + 0.5} x2={GRID.timeColumn + colW * (i + 1) + 0.5} y1={0} y2={H} stroke={line} strokeWidth={1} />
      ))}
    </Svg>
  );
});

/** «08:00» 13/600 `ink3` in the 56 column; hours before now paler (×0.7). */
const HourLabels = memo(function HourLabels({ nowMin }: { nowMin: number }) {
  const theme = useTheme();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: 24 }, (_, h) => (
        <AppText
          key={h}
          nativeID="v5-one-line"
          maxFontSizeMultiplier={1}
          style={[
            styles.abs,
            {
              left: 0,
              width: GRID.timeColumn,
              paddingLeft: theme.m.gutter,
              top: yOf(h * 60) - 9,
              fontFamily: theme.type.sheetMeta.fontFamily,
              fontSize: 13,
              lineHeight: 18,
              color: theme.colors.ink3,
              fontVariant: ['tabular-nums'],
              opacity: h * 60 < nowMin ? 0.7 : 1,
            },
          ]}
        >
          {hhmm(h * 60)}
        </AppText>
      ))}
    </View>
  );
});

/** §7: empty hours are invisible buttons «10:00, свободно. Добавить» for TalkBack / VoiceOver only. */
function EmptyHourButtons({ dates, entries, onAdd }: { dates: string[]; entries: CalEntry[]; onAdd: (date: string, start: number) => void }) {
  const { t } = useTranslation();
  const date = dates[0]!;
  const busy = new Set<number>();
  for (const e of entries) if (e.date === date) for (let h = Math.floor(e.start! / 60); h * 60 < endOf(e); h += 1) busy.add(h);
  return (
    // Under the gesture layer: fingers reach the layer, screen readers find these.
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { opacity: 0 }]}>
      {Array.from({ length: 24 }, (_, h) =>
        busy.has(h) ? null : (
          <Pressable
            key={h}
            accessibilityRole="button"
            accessibilityLabel={t('cal.free_a11y', { time: hhmm(h * 60) })}
            onAccessibilityTap={() => onAdd(date, h * 60)}
            onPress={() => onAdd(date, h * 60)}
            style={[styles.abs, { top: yOf(h * 60), height: 60, left: GRID.timeColumn, right: 0 }]}
          />
        ),
      )}
    </View>
  );
}

/** «Сейчас»: 2 `ink` with a 10 dot at its left end, the «09:41» tag 12/800 in the time column. */
function NowLine({ nowMin }: { nowMin: number }) {
  const theme = useTheme();
  const c = theme.colors;
  const top = yOf(nowMin);
  return (
    <>
      <View testID="cal-now" pointerEvents="none" style={[styles.abs, { left: GRID.timeColumn, right: 0, top: top - 1, height: 2, backgroundColor: c.ink, zIndex: 3 }]}>
        <View style={{ position: 'absolute', left: -5, top: -4, width: 10, height: 10, borderRadius: 5, backgroundColor: c.ink }} />
      </View>
      <View pointerEvents="none" style={[styles.abs, { left: 6, top: top - 11, zIndex: 3, backgroundColor: c.ink, borderRadius: 9, paddingHorizontal: 6, paddingVertical: 5 }]}>
        <AppText maxFontSizeMultiplier={1} style={{ color: c.paper, fontFamily: theme.type.title.fontFamily, fontSize: 12, lineHeight: 12, fontVariant: ['tabular-nums'] }}>
          {hhmm(nowMin)}
        </AppText>
      </View>
    </>
  );
}

/** Diagonal hatching of free time (`repeating-linear-gradient(135deg, …)`). */
export function Hatch({ color }: { color: string }) {
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Defs>
        <Pattern id="calHatch" width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <Rect x={0} y={0} width={1} height={8} fill={color} />
        </Pattern>
      </Defs>
      <Rect x={0} y={0} width="100%" height="100%" fill="url(#calHatch)" />
    </Svg>
  );
}

/** «окно 1 ч 40 мин» from now to the next block (≥ 30 min); a tap adds into it. */
function WindowBlock({ top, height, label, onPress }: { top: number; height: number; label: string; onPress: () => void }) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <Pressable
      testID="cal-window"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.abs, styles.center, { top, height, left: GRID.timeColumn + 3, right: 6, borderRadius: 12, borderWidth: 1.5, borderColor: c.line2, overflow: 'hidden', zIndex: 1 }]}
    >
      <Hatch color={c.line} />
      <View style={{ backgroundColor: c.paper, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 }}>
        <AppText style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 14, lineHeight: 16, color: c.ink2 }}>{label}</AppText>
      </View>
    </Pressable>
  );
}

/** A reminder: a 1.5 `ink` line on its time across the column and a small capsule under it (by its text width). */
function ReminderMark({ e, left, width, small, onOpen }: { e: CalEntry; left: number; width: number; small: boolean; onOpen: (e: CalEntry) => void }) {
  const theme = useTheme();
  const c = theme.colors;
  const done = e.done;
  return (
    <View pointerEvents="box-none" style={[styles.abs, { top: yOf(e.start!), left, width, height: 28, zIndex: 2 }]}>
      <View pointerEvents="none" style={{ height: 1.5, backgroundColor: done ? c.line2 : c.ink }} />
      <Pressable
        testID={`cal-rem-${e.key}`}
        accessibilityRole="button"
        accessibilityLabel={`${hhmm(e.start!)}. ${e.title}`}
        onPress={() => onOpen(e)}
        hitSlop={{ top: 9, bottom: 9 }}
        style={{
          alignSelf: 'flex-start',
          maxWidth: '100%',
          height: GRID.capsule,
          marginTop: 1,
          borderTopRightRadius: 13,
          borderBottomRightRadius: 13,
          borderBottomLeftRadius: 13,
          backgroundColor: c.paper,
          borderWidth: done ? 1 : 1.5,
          borderColor: done ? c.line2 : c.ink,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingLeft: 8,
          paddingRight: 11,
        }}
      >
        {small ? null : <Bell size={15} color={done ? c.ink3 : c.ink} strokeWidth={theme.icon.strokeWidth} />}
        <AppText
          numberOfLines={1}
          style={{
            flexShrink: 1,
            fontFamily: theme.type.headline.fontFamily,
            fontSize: 14,
            lineHeight: 16,
            color: done ? c.ink3 : c.ink,
            textDecorationLine: done ? 'line-through' : 'none',
          }}
        >
          {e.title}
        </AppText>
      </Pressable>
    </View>
  );
}

function DraftBlock({ draft, left, width }: { draft: GridDraft; left: number; width: number }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const c = theme.colors;
  const box = blockBox(draft.start, draft.duration);
  return (
    <View testID="cal-draft" pointerEvents="none" style={[styles.abs, { top: box.top, height: box.height, left, width, zIndex: 4, borderRadius: 12, backgroundColor: c.paper, borderWidth: 1.5, borderColor: c.ink, paddingHorizontal: 9, paddingTop: 6 }]}>
      <AppText numberOfLines={1} style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15, lineHeight: 19, color: c.ink3 }}>
        {t('cal.new')}
      </AppText>
      {box.height > 44 ? (
        <AppText variant="footnote" style={{ color: c.ink3, fontVariant: ['tabular-nums'] }}>{`${hhmm(draft.start)}–${hhmm(draft.start + draft.duration)}`}</AppText>
      ) : null}
      <View style={[styles.knob, { backgroundColor: c.paper, borderColor: c.ink, bottom: -11 }]} />
    </View>
  );
}

type BlockProps = {
  e: CalEntry;
  state: BlockState;
  now: number;
  left: number;
  width: number;
  small: boolean;
  ring: boolean;
  selected: boolean;
  dragEnabled: boolean;
  onOpen: (e: CalEntry) => void;
  onToggle: (e: CalEntry) => void;
  onLift: (key: string) => void;
  onStep: (min: number | null) => void;
  onDrop: (e: CalEntry, dx: number, dy: number, resize: boolean) => void;
};

/**
 * A block: `paper2`, radius 12, the 20 check at its left, the title 15/650, a second line 13 when taller than 44.
 * Now = `ink` fill; next = outline 2 + «через …»; past not done = outline `line2` «прошло · не отмечено»; done = outline,
 * struck title, filled check; a plan step = a 3 `ink` bar at the left; the assistant's new one = a terracotta ring.
 */
const Block = memo(function Block(b: BlockProps) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const reduced = useReducedMotion();
  const c = theme.colors;
  const { e, state } = b;
  const box = blockBox(e.start!, e.duration);
  const dx = useSharedValue(0);
  const dy = useSharedValue(0);
  const dh = useSharedValue(0);
  const lifted = useSharedValue(0);
  // The new place came with the props: the finger's offset is part of it now.
  useLayoutEffect(() => {
    dx.set(0);
    dy.set(0);
    dh.set(0);
  }, [e.start, e.date, e.duration, dx, dy, dh]);
  const start = e.start!;
  const lastStep = useSharedValue(0);
  const move = useMemo(
    () =>
      Gesture.Pan()
        .enabled(b.dragEnabled)
        .activateAfterLongPress(400)
        .onStart(() => {
          lastStep.set(0);
          lifted.set(1);
          runOnJS(b.onLift)(e.key);
          runOnJS(b.onStep)(start);
        })
        .onUpdate((g) => {
          dx.set(g.translationX);
          dy.set(g.translationY);
          const s = Math.round(g.translationY / 15);
          if (s !== lastStep.get()) {
            lastStep.set(s);
            runOnJS(b.onStep)(Math.max(0, Math.min(1425, start + s * 15)));
          }
        })
        .onEnd((g) => {
          lifted.set(0);
          dy.set(withTiming(Math.round(g.translationY / 15) * 15, { duration: 200 }));
          runOnJS(b.onDrop)(e, g.translationX, g.translationY, false);
        })
        .onFinalize(() => {
          lifted.set(0);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- worklet closures over this block's start
    [b.dragEnabled, e.key, start],
  );
  const resize = useMemo(
    () =>
      Gesture.Pan()
        .enabled(b.dragEnabled)
        .onUpdate((g) => {
          dh.set(Math.round(g.translationY / 15) * 15);
        })
        .onEnd((g) => runOnJS(b.onDrop)(e, 0, g.translationY, true)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
    [b.dragEnabled, e.key, start],
  );
  const anim = useAnimatedStyle(() => ({
    transform: [{ translateX: dx.value }, { translateY: dy.value }, { scale: reduced ? 1 : 1 + 0.02 * lifted.value }],
    height: Math.max(GRID.minBlock, box.height + dh.value),
    zIndex: lifted.value > 0 ? 6 : 2,
  }));

  const cur = state === 'current';
  const ink = cur ? c.paper : state === 'past' ? c.ink2 : state === 'done' ? c.ink3 : c.ink;
  const outline = state === 'past' || state === 'done';
  const range = e.duration ? `${hhmm(start)}–${hhmm(start + e.duration)}` : hhmm(start);
  const until = start - minutesOf(b.now);
  const cap =
    state === 'current'
      ? `${range} · ${t('cal.now_word')}`
      : state === 'next'
        ? `${range} · ${t('cal.in', { time: durText(t, until) })}`
        : state === 'past'
          ? t('cal.passed')
          : state === 'done'
            ? t('cal.done_word')
            : e.plan
              ? t('cal.step_of', { plan: e.plan.title })
              : range;
  const fresh = e.source === 'assistant' && markFresh(e.changedAt, b.now);
  let day = e.date;
  try {
    day = new Date(`${e.date}T12:00:00`).toLocaleDateString(i18n.language, { weekday: 'long' });
  } catch {
    // the ISO date stays
  }
  const label = t('cal.block_a11y', {
    title: e.title,
    day,
    range,
    state: e.done ? t('cal.state_done') : t('cal.state_not_done'),
  });
  const showCheck = !b.small && e.kind === 'task';
  return (
    <>
      {b.selected ? (
        // The old place stays outlined while the block is up.
        <View pointerEvents="none" style={[styles.abs, { top: box.top, height: box.height, left: b.left, width: b.width, borderRadius: 12, borderWidth: 1.5, borderColor: c.line2, borderStyle: 'dashed' }]} />
      ) : null}
      <GestureDetector gesture={move}>
        <Animated.View
          style={[
            styles.abs,
            { top: box.top, left: b.left, width: b.width, borderRadius: 12 },
            b.selected ? elevationV5Notice : null,
            anim,
          ]}
        >
          <Pressable
            testID={`cal-block-${e.key}`}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityActions={[
              ...(e.kind === 'task' ? [{ name: 'done', label: t('cal.act_done') }] : []),
              { name: 'activate', label: t('cal.view_day') },
            ]}
            onAccessibilityAction={(ev) => (ev.nativeEvent.actionName === 'done' ? b.onToggle(e) : b.onOpen(e))}
            onPress={() => b.onOpen(e)}
            hitSlop={box.height < 44 ? { top: (44 - box.height) / 2, bottom: (44 - box.height) / 2 } : undefined}
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: 12,
                flexDirection: 'row',
                gap: 7,
                paddingHorizontal: b.small ? 6 : 9,
                paddingTop: b.small ? 4 : 6,
                paddingBottom: 5,
                overflow: 'hidden',
                backgroundColor: cur ? c.ink : outline ? 'transparent' : c.paper2,
                borderWidth: b.ring ? 2 : state === 'next' ? 2 : outline ? 1 : b.selected ? 1.5 : 0,
                borderColor: b.ring ? c.place.assistant : state === 'next' || b.selected ? c.ink : c.line2,
                borderLeftWidth: e.kind === 'plan_step' ? 3 : undefined,
                borderLeftColor: e.kind === 'plan_step' ? c.ink : undefined,
              },
            ]}
          >
            {showCheck ? (
              <Pressable
                testID={`cal-check-${e.key}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: e.done }}
                accessibilityLabel={e.title}
                onPress={() => {
                  if (!e.done) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
                  b.onToggle(e);
                }}
                hitSlop={12}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  marginTop: box.height < 44 ? -1 : 0,
                  borderWidth: e.done ? 0 : 1.8,
                  borderColor: e.pending ? c.ink3 : cur ? c.paper : c.ink,
                  borderStyle: e.pending && !e.done ? 'dashed' : 'solid',
                  backgroundColor: e.done ? c.ink3 : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {e.done ? <Check size={13} color={c.paper} strokeWidth={3} /> : null}
              </Pressable>
            ) : null}
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText
                numberOfLines={b.small ? 2 : 1}
                maxFontSizeMultiplier={1.3}
                style={{
                  fontFamily: state === 'past' || state === 'done' ? theme.type.sheetMeta.fontFamily : theme.type.headline.fontFamily,
                  fontSize: b.small ? 14 : 15,
                  lineHeight: b.small ? 17 : 19,
                  color: ink,
                  textDecorationLine: state === 'done' ? 'line-through' : 'none',
                }}
              >
                {e.title}
              </AppText>
              {box.height > 44 && !b.small ? (
                <AppText numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ fontSize: 13, lineHeight: 17, color: cur ? c.paper : c.ink3, opacity: cur ? 0.85 : 1, fontVariant: ['tabular-nums'] }}>
                  {cap}
                </AppText>
              ) : null}
              {fresh && box.height > 62 && !b.small ? (
                <AppText numberOfLines={1} style={{ fontFamily: theme.type.mark.fontFamily, fontSize: 13, lineHeight: 15, color: cur ? c.paper : c.assistantText }}>
                  {t('cal.assistant')}
                </AppText>
              ) : null}
            </View>
          </Pressable>
          {b.selected && b.dragEnabled ? (
            <GestureDetector gesture={resize}>
              <View testID={`cal-knob-${e.key}`} hitSlop={11} style={[styles.knob, { backgroundColor: c.paper, borderColor: c.ink, bottom: -11 }]} />
            </GestureDetector>
          ) : null}
        </Animated.View>
      </GestureDetector>
    </>
  );
});

const elevationV5Notice = { shadowColor: '#000000', shadowOffset: { width: 0, height: 14 }, shadowRadius: 26, shadowOpacity: 0.45, elevation: 12 };

const styles = StyleSheet.create({
  flex: { flex: 1 },
  abs: { position: 'absolute' },
  center: { alignItems: 'center', justifyContent: 'center' },
  knob: { position: 'absolute', left: '50%', marginLeft: -11, width: GRID.knob, height: GRID.knob, borderRadius: 11, borderWidth: 2, zIndex: 5 },
});
