import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';

import { plan as P, useTheme } from '@/theme';

import { AppText } from '../AppText';
import { pressedStyle } from './motion';

/**
 * «План дня» from «Ритм» (design-system §11.8): block height = duration (1 dp per minute, at least 40), a 56 time
 * column, the current / next one a black block, done ones an outline with struck text, «сейчас» a line in the text
 * colour with its «9:41» tag, empty time after now a hatched block «свободно 2 ч». From font 1.3 (`planAsRows`) it is
 * rows «время — дело», free time a row too.
 */
export type PlanItem = {
  id: string;
  /** Minutes from midnight. */
  start: number;
  /** Minutes; unknown → a 40 dp block that takes no time of the day. */
  duration?: number;
  title: string;
  done?: boolean;
  onPress?: () => void;
  testID?: string;
  /** The whole block for a screen reader («Пропущено 12:00 · Позвонить в банк»). */
  label?: string;
};

type Piece =
  | { kind: 'item'; item: PlanItem; main: boolean; height: number }
  | { kind: 'free'; minutes: number; start: number; height: number }
  | { kind: 'now' };

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const shortNow = (min: number) => `${Math.floor(min / 60) % 24}:${String(min % 60).padStart(2, '0')}`;

/** Pure: the pieces of the plan for `now` (minutes). Exported for tests. */
export function planPieces(items: readonly PlanItem[], now: number, minFree = 30): Piece[] {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const out: Piece[] = [];
  let nowPlaced = false;
  let mainPlaced = false;
  sorted.forEach((it, i) => {
    if (!nowPlaced && it.start > now) {
      out.push({ kind: 'now' });
      nowPlaced = true;
    }
    const isMain = !mainPlaced && !it.done && it.start + (it.duration ?? 0) >= now;
    if (isMain) mainPlaced = true;
    out.push({ kind: 'item', item: it, main: isMain, height: Math.max(P.minBlock, (it.duration ?? 0) * P.dpPerMinute) });
    const next = sorted[i + 1];
    if (next) {
      // Free time is only what is still ahead, between two things of the plan (not from «now»).
      const end = it.start + (it.duration ?? 0);
      const gap = next.start - end;
      if (end >= now && gap >= minFree) out.push({ kind: 'free', minutes: gap, start: end, height: Math.min(gap * P.dpPerMinute, P.maxFree) });
    }
  });
  if (!nowPlaced && sorted.length > 0) out.push({ kind: 'now' });
  return out;
}

export function useDuration() {
  const { t } = useTranslation();
  return (min: number) => {
    if (min < 60) return t('plan.min', { n: min });
    const h = min / 60;
    const text = Number.isInteger(h) ? String(h) : h.toFixed(1).replace('.', ',');
    return t('plan.hours', { h: text });
  };
}

export function DayPlan({ items, now, testID = 'day-plan' }: { items: readonly PlanItem[]; now: number; testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const dur = useDuration();
  const pieces = planPieces(items, now);
  const c = theme.colors;

  if (theme.m.planAsRows) {
    return (
      <View testID={testID}>
        {pieces.map((p, i) => {
          if (p.kind === 'now') return null;
          const first = i === 0 || pieces.slice(0, i).every((x) => x.kind === 'now');
          const time = p.kind === 'item' ? hhmm(p.item.start) : hhmm(p.start);
          const free = p.kind === 'free';
          return (
            <Pressable
              key={p.kind === 'item' ? p.item.id : `free-${p.start}`}
              testID={p.kind === 'item' ? p.item.testID : undefined}
              disabled={free || !p.item.onPress}
              onPress={p.kind === 'item' ? p.item.onPress : undefined}
              accessibilityRole={free ? undefined : 'button'}
              style={[styles.row, { minHeight: theme.m.row, borderTopWidth: first ? 0 : 1, borderTopColor: c.line, gap: 12 }]}
            >
              <AppText style={[theme.type.planTime, { width: 66, color: free ? c.ink2 : c.ink, fontSize: 21 * 0.8, lineHeight: 24 }]}>{time}</AppText>
              <AppText numberOfLines={1} style={[styles.flex, { color: free ? c.ink2 : c.ink }, p.kind === 'item' && p.item.done ? styles.strike : null]}>
                {free ? t('plan.free', { time: dur(p.minutes) }) : p.item.title}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    );
  }

  return (
    <View testID={testID} style={{ paddingLeft: P.timeColumn }}>
      {pieces.map((p, i) => {
        if (p.kind === 'now')
          return (
            <View key={`now-${i}`} testID="plan-now" style={{ height: 0, marginTop: 2, marginBottom: 6, borderTopWidth: 2, borderTopColor: c.ink }}>
              <View style={[styles.nowTag, { backgroundColor: c.ink, left: -P.timeColumn }]}>
                <AppText style={{ color: c.paper, fontFamily: theme.type.title.fontFamily, fontSize: 12, lineHeight: 12, fontVariant: ['tabular-nums'] }} nativeID="v5-capped" maxFontSizeMultiplier={1.2}>
                  {shortNow(now)}
                </AppText>
              </View>
            </View>
          );
        if (p.kind === 'free') {
          const label = p.minutes >= 60 ? t('plan.free', { time: dur(p.minutes) }) : dur(p.minutes);
          return (
            <View key={`free-${p.start}`} testID="plan-free" style={[styles.free, { minHeight: p.height, borderColor: c.line2, marginBottom: P.blockGap }]}>
              <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
                <Defs>
                  <Pattern id={`h${i}`} width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <Line x1={0} y1={0} x2={0} y2={8} stroke={c.line} strokeWidth={1.5} />
                  </Pattern>
                </Defs>
                <Rect x="0" y="0" width="100%" height="100%" fill={`url(#h${i})`} />
              </Svg>
              {p.height >= 22 ? (
                <View style={{ backgroundColor: c.paper, paddingHorizontal: 10, paddingVertical: 2, borderRadius: 10 }}>
                  <AppText style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 14, lineHeight: 18, color: c.ink2 }} nativeID="v5-capped" maxFontSizeMultiplier={1.2}>
                    {label}
                  </AppText>
                </View>
              ) : null}
            </View>
          );
        }
        const { item, main } = p;
        const done = !!item.done;
        const fg = main ? c.paper : done ? c.ink3 : c.ink;
        return (
          <Pressable
            key={item.id}
            testID={item.testID}
            disabled={!item.onPress}
            onPress={item.onPress}
            accessibilityRole={item.onPress ? 'button' : undefined}
            accessibilityLabel={item.label ?? `${hhmm(item.start)} ${item.title}`}
            style={({ pressed }) => [
              styles.blk,
              { minHeight: p.height, marginBottom: P.blockGap, backgroundColor: main ? c.ink : done ? 'transparent' : c.paper2 },
              done ? { borderWidth: 1, borderColor: c.line } : null,
              pressedStyle(pressed),
            ]}
          >
            <AppText style={[theme.type.planTime, styles.time, { left: -P.timeColumn, color: c.ink }]} nativeID="v5-capped" maxFontSizeMultiplier={1.2}>
              {hhmm(item.start)}
            </AppText>
            <View style={[styles.row, { gap: 10 }]}>
              <AppText
                numberOfLines={1}
                style={[styles.flex, { fontFamily: done ? theme.type.bodyStrong.fontFamily : theme.type.headline.fontFamily, fontSize: 15.5, lineHeight: 20, color: fg }, done ? styles.strike : null]}
              >
                {item.title}
              </AppText>
              {item.duration && theme.m.size !== 'small' ? (
                <AppText variant="footnote" style={{ color: main ? c.paper : c.ink3, opacity: main ? 0.85 : 1 }}>
                  {dur(item.duration)}
                </AppText>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  strike: { textDecorationLine: 'line-through' },
  blk: { borderRadius: P.radius, paddingVertical: 6, paddingHorizontal: 12, justifyContent: 'center' },
  time: { position: 'absolute', top: 10, width: 48 },
  free: { borderRadius: P.radius, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  nowTag: { position: 'absolute', top: -11, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 9 },
});

/** A hatched «free time» block on its own (the empty day: «ничего не запланировано»). */
export function FreeBlock({ label, height = 56 }: { label: string; height?: number }) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <View testID="plan-free" style={[styles.free, { minHeight: height, borderColor: c.line2 }]}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <Pattern id="hfree" width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <Line x1={0} y1={0} x2={0} y2={8} stroke={c.line} strokeWidth={1.5} />
          </Pattern>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#hfree)" />
      </Svg>
      <View style={{ backgroundColor: c.paper, paddingHorizontal: 10, paddingVertical: 2, borderRadius: 10 }}>
        <AppText style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 14, lineHeight: 18, color: c.ink2 }}>{label}</AppText>
      </View>
    </View>
  );
}
