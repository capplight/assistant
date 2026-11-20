import { AlarmClock, Bell, ChevronRight } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { CalEntry } from '@/calendar/entries';
import type { DayPeriod } from '@/calendar/period';
import { hmShort } from '@/calendar/time';
import { AppText } from '@/components/AppText';
import { durText } from '@/components/calendar/parts';
import { CheckMark } from '@/components/ui/Check';
import { SectionHead } from '@/components/ui/Leaf';
import { pressedStyle, useReducedMotion } from '@/components/ui/motion';
import { reducedMotionFade, todayPlan, useTheme } from '@/theme';
import type { DayPlanParts, PlanRow } from '@/today/v6';

/** Row texts stay inside the fixed row height (the rows never grow, so «Прошло» and a tick animate exact heights). */
const ROW_TEXT_CAP = 1.6;

/**
 * today-v6-acceptance.md §3.4 — «План» (option A: the nearest one is an ordinary row, it is already in the card).
 * Morning and day: «План · Все дела ›», «Прошло {n} · не отмечено {m} ›» (opens in place, 200 ms on the UI thread, with
 * [Сделано]), the timed things ahead, then the to-dos without a time; 4 rows under 400 dp, 5 from 400, then «Ещё N ›».
 * Evening: «Осталось с сегодня» (≤ 2, [На завтра]) and «Завтра, {день}» (≤ 3, read only). Night: «Завтра, {день}» and
 * «Будильник на 8:00 стоит» when one is set. Rows are 52 (68 with large text), fixed.
 */
export function TodayPlan(p: {
  period: DayPeriod;
  /** Minutes from midnight. */
  nowMin: number;
  parts: DayPlanParts;
  left: PlanRow[];
  coming: CalEntry[];
  comingTitle: string;
  alarm: string | null;
  limit: number;
  onAll: () => void;
  onOpen: (r: PlanRow) => void;
  onToggle: (r: PlanRow, done: boolean) => void;
  onMarkDone: (r: PlanRow) => void;
  onTomorrow: (r: PlanRow) => void;
  /**
   * Review 1 Р1: the evening (or the night before midnight) with timed things still ahead today — «План» as in the day,
   * then «Завтра, {день}»; no «Осталось с сегодня» (what is not ticked is in «Прошло»).
   */
  late?: boolean;
}) {
  const { t } = useTranslation();
  if (p.late) {
    const coming = p.coming.slice(0, 3);
    const alarm = p.period === 'night' ? p.alarm : null;
    return (
      <DayPlanBlock
        {...p}
        after={
          <>
            {coming.length > 0 ? <ComingRows title={p.comingTitle} rows={coming} /> : null}
            {alarm ? <AlarmLine time={alarm} /> : null}
          </>
        }
      />
    );
  }
  if (p.period === 'evening' || p.period === 'night') {
    const left = p.period === 'evening' ? p.left.slice(0, 2) : [];
    const coming = p.coming.slice(0, 3);
    const alarm = p.period === 'night' ? p.alarm : null;
    if (left.length === 0 && coming.length === 0 && !alarm) return null;
    return (
      <View testID="today-plan">
        {left.length > 0 ? (
          <View testID="today-left">
            <SectionHead first title={t('today6.left')} />
            {left.map((r, i) => (
              <PlanLine
                key={r.key}
                row={r}
                first={i === 0}
                onOpen={p.onOpen}
                onToggle={p.onToggle}
                right={<SmallButton testID={`today-to-tomorrow-${r.key}`} label={t('today6.to_tomorrow')} outline onPress={() => p.onTomorrow(r)} />}
              />
            ))}
          </View>
        ) : null}
        {coming.length > 0 ? <ComingRows first={left.length === 0} title={p.comingTitle} rows={coming} /> : null}
        {alarm ? <AlarmLine time={alarm} /> : null}
      </View>
    );
  }
  return <DayPlanBlock {...p} />;
}

function DayPlanBlock(p: Parameters<typeof TodayPlan>[0] & { after?: ReactNode }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const row = theme.m.largeText ? todayPlan.rowLarge : todayPlan.row;
  const { past, unmarked, ahead, untimed } = p.parts;

  // A ticked row leaves to «Прошло» by its height (UI thread); until then it stays where it was, as a ghost.
  const [ghosts, setGhosts] = useState<{ row: PlanRow; at: number }[]>([]);
  const live = [...ahead, ...untimed];
  const list = [...live];
  for (const g of ghosts) if (!list.some((r) => r.key === g.row.key)) list.splice(Math.min(g.at, list.length), 0, { ...g.row, done: true });
  const shown = list.slice(0, p.limit + ghosts.length);
  const hidden = Math.max(0, live.length - p.limit);
  const tick = (r: PlanRow, done: boolean) => {
    if (done) setGhosts((g) => [...g.filter((x) => x.row.key !== r.key), { row: r, at: list.findIndex((x) => x.key === r.key) }]);
    p.onToggle(r, done);
  };

  if (past.length + live.length + ghosts.length === 0) return null;
  return (
    <View testID="today-plan">
      <SectionHead first title={t('today6.plan')} link={t('today6.all_tasks')} onLink={p.onAll} linkTestID="today-all-tasks" />
      {past.length > 0 ? <PastBlock rows={past} unmarked={unmarked} row={row} onOpen={p.onOpen} onToggle={p.onToggle} onMarkDone={p.onMarkDone} /> : null}
      {shown.map((r, i) => {
        const ghost = ghosts.some((g) => g.row.key === r.key) && !live.some((x) => x.key === r.key);
        return (
          <Leaving
            key={r.key}
            gone={ghost}
            height={row}
            reduced={reduced}
            onGone={() => setGhosts((g) => g.filter((x) => x.row.key !== r.key))}
          >
            <PlanLine row={r} first={i === 0 && past.length === 0} onOpen={p.onOpen} onToggle={tick} />
          </Leaving>
        );
      })}
      {hidden > 0 ? (
        <Pressable
          testID="today-plan-more"
          accessibilityRole="button"
          accessibilityLabel={t('today6.more', { n: hidden })}
          onPress={p.onAll}
          style={({ pressed }) => [
            { minHeight: todayPlan.past, flexDirection: 'row', alignItems: 'center', gap: 2, borderTopWidth: 1, borderTopColor: theme.colors.line },
            pressedStyle(pressed),
          ]}
        >
          <AppText numberOfLines={1} maxFontSizeMultiplier={ROW_TEXT_CAP} style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15, lineHeight: 18, color: theme.colors.ink }}>
            {t('today6.more', { n: hidden })}
          </AppText>
          <ChevronRight size={15} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
        </Pressable>
      ) : null}
      {p.after}
    </View>
  );
}

/** A row that collapses to 0 (200 ms, UI thread) once `gone`, then tells. */
function Leaving({ gone, height, reduced, onGone, children }: { gone: boolean; height: number; reduced: boolean; onGone: () => void; children: ReactNode }) {
  const h = useSharedValue(height);
  useEffect(() => {
    if (!gone) {
      h.set(height);
      return;
    }
    h.set(withTiming(0, { duration: reduced ? reducedMotionFade : todayPlan.expandMs }, (finished) => {
      if (finished) runOnJS(onGone)();
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per state change of `gone`
  }, [gone, height]);
  // The fixed height is there only while the row leaves; otherwise the row is free to grow (the 200% rule).
  const style = useAnimatedStyle(() => (gone ? { height: h.value, overflow: 'hidden' as const } : {}), [gone]);
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** «Прошло 3 · не отмечено 1 ›»: one 44 row; a tap opens the passed rows in place (height on the UI thread). */
function PastBlock({
  rows,
  unmarked,
  row,
  onOpen,
  onToggle,
  onMarkDone,
}: {
  rows: PlanRow[];
  unmarked: PlanRow[];
  row: number;
  onOpen: (r: PlanRow) => void;
  onToggle: (r: PlanRow, done: boolean) => void;
  onMarkDone: (r: PlanRow) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [drawn, setDrawn] = useState(false);
  // Opened and settled: no fixed height any more (rows may grow with the font; the 200% rule).
  const [settled, setSettled] = useState(false);
  const h = useSharedValue(0);
  const full = rows.length * row;
  useEffect(() => {
    const duration = reduced ? reducedMotionFade : todayPlan.expandMs;
    if (open)
      h.set(
        withTiming(full, { duration }, (finished) => {
          if (finished) runOnJS(setSettled)(true);
        }),
      );
    else
      h.set(
        withTiming(0, { duration }, (finished) => {
          if (finished) runOnJS(setDrawn)(false);
        }),
      );
  }, [open, full, reduced, h]);
  const style = useAnimatedStyle(() => (settled ? {} : { height: h.value, overflow: 'hidden' as const }), [settled]);
  const n = rows.length;
  const m = unmarked.length;
  const text = m > 0 ? t('today6.past', { n, m }) : t('today6.past_all', { n });
  const label = open ? t('today6.past_a11y_close', { n }) : m > 0 ? t('today6.past_a11y', { n, m }) : t('today6.past_a11y_all', { n });
  const unmarkedKeys = new Set(unmarked.map((r) => r.key));
  return (
    <View testID="today-past">
      <Pressable
        testID="today-past-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        onPress={() => {
          if (!open) setDrawn(true);
          setSettled(false);
          setOpen(!open);
        }}
        style={({ pressed }) => [{ minHeight: todayPlan.past, flexDirection: 'row', alignItems: 'center', gap: 2 }, pressedStyle(pressed)]}
      >
        <AppText numberOfLines={1} maxFontSizeMultiplier={ROW_TEXT_CAP} style={{ flexShrink: 1, fontSize: 15, lineHeight: 18, color: theme.colors.ink3 }}>
          {text}
        </AppText>
        <ChevronRight size={15} color={theme.colors.ink3} strokeWidth={theme.icon.strokeWidth} style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }} />
      </Pressable>
      <Animated.View testID="today-past-rows" style={style} accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}>
        {drawn
          ? rows.map((r) => (
              <PlanLine
                key={r.key}
                row={r}
                first={false}
                past
                onOpen={onOpen}
                onToggle={onToggle}
                right={unmarkedKeys.has(r.key) ? <SmallButton testID={`today-past-done-${r.key}`} label={t('today6.done')} onPress={() => onMarkDone(r)} /> : null}
              />
            ))
          : null}
      </Animated.View>
    </View>
  );
}

/** One row of the plan: the time column 46, the check 24 (a reminder: the bell 18), the title 16 and its meta 13. */
function PlanLine({
  row: r,
  first,
  past,
  readOnly,
  onOpen,
  onToggle,
  right,
}: {
  row: PlanRow;
  first: boolean;
  past?: boolean;
  readOnly?: boolean;
  onOpen?: (r: PlanRow) => void;
  onToggle?: (r: PlanRow, done: boolean) => void;
  right?: ReactNode;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const c = theme.colors;
  const height = theme.m.largeText ? todayPlan.rowLarge : todayPlan.row;
  const meta =
    r.meta ??
    (r.kind === 'reminder'
      ? t('today6.reminder')
      : r.kind === 'todo' || r.start === null
        ? t('today6.untimed')
        : r.duration
          ? durText(t, r.duration)
          : null);
  const mark =
    r.kind === 'reminder' ? (
      <View style={{ width: todayPlan.check, alignItems: 'center' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Bell size={todayPlan.bell} color={c.ink} strokeWidth={theme.icon.strokeWidth} />
      </View>
    ) : readOnly || !onToggle ? (
      <CheckMark checked={r.done} size={todayPlan.check} />
    ) : (
      <Pressable
        testID={`today-check-${r.key}`}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: r.done }}
        accessibilityLabel={r.title}
        onPress={() => onToggle(r, !r.done)}
        hitSlop={12}
      >
        <CheckMark checked={r.done} waiting={r.entry.pending} size={todayPlan.check} />
      </Pressable>
    );
  const body = (
    <>
      <AppText
        numberOfLines={1}
        nativeID="v5-one-line"
        maxFontSizeMultiplier={ROW_TEXT_CAP}
        style={{ width: todayPlan.timeColumn, fontFamily: theme.type.headline.fontFamily, fontSize: 14, lineHeight: 18, fontVariant: ['tabular-nums'], color: past ? c.ink2 : c.ink }}
      >
        {r.start !== null ? hmShort(r.start) : ''}
      </AppText>
      {mark}
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText
          numberOfLines={1}
          maxFontSizeMultiplier={ROW_TEXT_CAP}
          style={[
            { fontSize: 16, lineHeight: 21, color: past ? c.ink2 : c.ink },
            r.done ? { color: c.ink3, textDecorationLine: 'line-through' } : null,
          ]}
        >
          {r.title}
        </AppText>
        {meta ? (
          <AppText numberOfLines={1} maxFontSizeMultiplier={ROW_TEXT_CAP} style={{ fontSize: 13, lineHeight: 17, color: c.ink3 }}>
            {meta}
          </AppText>
        ) : null}
      </View>
      {right}
    </>
  );
  const style = { minHeight: height, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, borderTopWidth: first ? 0 : 1, borderTopColor: c.line };
  if (readOnly || !onOpen)
    return (
      <View testID={`today-row-${r.key}`} style={style} accessible accessibilityLabel={`${r.start !== null ? hmShort(r.start) : ''} ${r.title}`.trim()}>
        {body}
      </View>
    );
  return (
    <Pressable
      testID={`today-row-${r.key}`}
      accessibilityRole="button"
      accessibilityLabel={`${r.start !== null ? hmShort(r.start) : ''} ${r.title}`.trim()}
      onPress={() => onOpen(r)}
      style={({ pressed }) => [style, pressedStyle(pressed)]}
    >
      {body}
    </Pressable>
  );
}

/** [На завтра] (outline) / [Сделано] (filled): 34 high, a 44 target. */
function SmallButton({ testID, label, onPress, outline }: { testID: string; label: string; onPress: () => void; outline?: boolean }) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={5}
      style={({ pressed }) => [
        {
          minHeight: todayPlan.button,
          borderRadius: todayPlan.button / 2,
          paddingHorizontal: 14,
          justifyContent: 'center',
          backgroundColor: outline ? 'transparent' : c.btn,
          borderWidth: outline ? 1.5 : 0,
          borderColor: c.ink,
        },
        pressedStyle(pressed),
      ]}
    >
      <AppText nativeID="v5-capped" numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 14, lineHeight: 18, color: outline ? c.ink : c.onBtn }}>
        {label}
      </AppText>
    </Pressable>
  );
}

/** «Завтра, суббота» / «Пятница, 27 ноября»: up to 3 read-only rows with their circles (no «Календарь ›»: the card is). */
export function ComingRows({ title, rows, first, testID = 'today-coming' }: { title: string; rows: CalEntry[]; first?: boolean; testID?: string }) {
  return (
    <View testID={testID}>
      <SectionHead first={first} title={title} />
      {rows.slice(0, 3).map((e, i) => (
        <PlanLine
          key={e.key}
          readOnly
          first={i === 0}
          row={{ key: e.key, kind: e.kind, title: e.title, start: e.allDay ? null : e.start, duration: e.duration, done: e.done, entry: e }}
        />
      ))}
    </View>
  );
}

/** «Будильник на 8:00 стоит»: 13 `ink3` with a 15 alarm clock. */
function AlarmLine({ time }: { time: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID="today-alarm" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
      <AlarmClock size={15} color={theme.colors.ink3} strokeWidth={theme.icon.strokeWidth} />
      <AppText numberOfLines={1} style={{ fontSize: 13, lineHeight: 17, color: theme.colors.ink3 }}>
        {t('today6.alarm', { time })}
      </AppText>
    </View>
  );
}
