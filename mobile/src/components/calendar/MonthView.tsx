import { Bell, ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { CalEntry } from '@/calendar/entries';
import { GRID } from '@/calendar/geometry';
import { hhmm, isoDate, monthGrid, weekDays } from '@/calendar/time';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { CheckMark } from '../ui/Check';
import { pressedStyle } from '../ui/motion';
import { dateText, durText } from './parts';

/**
 * «Месяц» (A3): a 7 × 6 grid, cells 50, the number 16 in a 32 circle, up to three 5 dots; today a 1.5 ring, the chosen
 * day filled `ink`. Under it the list of the chosen day; «День ›» or a second tap on the day opens its grid.
 */
export function MonthView({
  date,
  now,
  entries,
  onPick,
  onOpenDay,
  onOpen,
  onToggle,
}: {
  date: string;
  now: number;
  entries: CalEntry[];
  onPick: (d: string) => void;
  onOpenDay: (d: string) => void;
  onOpen: (e: CalEntry) => void;
  onToggle: (e: CalEntry) => void;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const c = theme.colors;
  const today = isoDate(now);
  const cells = monthGrid(date);
  const month = date.slice(0, 7);
  const count = new Map<string, number>();
  for (const e of entries) count.set(e.date, (count.get(e.date) ?? 0) + 1);
  const heads = weekDays(cells[0]!).map((d) => {
    try {
      return new Date(`${d}T12:00:00`).toLocaleDateString(i18n.language, { weekday: 'short' }).replace(/\.$/u, '');
    } catch {
      return d;
    }
  });
  const day = entries.filter((e) => e.date === date);
  let title = date;
  try {
    const s = new Date(`${date}T12:00:00`).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' });
    title = s.charAt(0).toUpperCase() + s.slice(1);
  } catch {
    // the ISO date stays
  }
  return (
    <ScrollView testID="cal-month-view" contentContainerStyle={{ paddingTop: 12, paddingBottom: GRID.bottomRoom + 24 }} showsVerticalScrollIndicator={false}>
      <View style={[styles.grid, { paddingHorizontal: theme.m.gutter - 8 }]}>
        {heads.map((h, i) => (
          <View key={`h${i}`} style={styles.head}>
            <AppText maxFontSizeMultiplier={1.3} style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 13, lineHeight: 15, color: c.ink3 }}>
              {h}
            </AppText>
          </View>
        ))}
        {cells.map((d) => {
          const other = d.slice(0, 7) !== month;
          const sel = d === date;
          const isToday = d === today;
          const n = Math.min(3, count.get(d) ?? 0);
          return (
            <Pressable
              key={d}
              testID={`cal-mday-${d}`}
              accessibilityRole="button"
              accessibilityState={{ selected: sel }}
              accessibilityLabel={`${dateText(i18n.language, d)}${n ? `, ${count.get(d)}` : ''}`}
              onPress={() => (sel ? onOpenDay(d) : onPick(d))}
              style={styles.cell}
            >
              <View
                style={[
                  styles.num,
                  sel ? { backgroundColor: c.ink } : isToday ? { borderWidth: 1.5, borderColor: c.ink } : null,
                ]}
              >
                <AppText
                  maxFontSizeMultiplier={1.2}
                  style={{
                    fontFamily: other ? theme.type.caption.fontFamily : theme.type.headline.fontFamily,
                    fontSize: 16,
                    lineHeight: 18,
                    fontVariant: ['tabular-nums'],
                    color: sel ? c.paper : other ? c.ink3 : c.ink,
                  }}
                >
                  {String(Number(d.slice(8)))}
                </AppText>
              </View>
              <View style={styles.dots}>
                {Array.from({ length: n }, (_, i) => (
                  <View key={i} style={[styles.dot, { backgroundColor: c.ink }]} />
                ))}
              </View>
            </Pressable>
          );
        })}
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: c.line, marginTop: 6, paddingTop: 12, paddingHorizontal: theme.m.gutter }}>
        <View style={styles.sec}>
          <AppText accessibilityRole="header" style={[theme.type.section, { color: c.ink, flex: 1 }]} numberOfLines={1}>
            {title}
          </AppText>
          <Pressable testID="cal-month-day" accessibilityRole="button" onPress={() => onOpenDay(date)} hitSlop={10} style={({ pressed }) => [styles.link, pressedStyle(pressed)]}>
            <AppText style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15, lineHeight: 18, color: c.ink }}>{t('cal.day_link')}</AppText>
            <ChevronRight size={18} color={c.ink} strokeWidth={theme.icon.strokeWidth} />
          </Pressable>
        </View>
        {day.length === 0 ? (
          <AppText testID="cal-month-empty" variant="footnote" style={{ color: c.ink3, paddingVertical: 12 }}>
            {t('cal.nothing')}
          </AppText>
        ) : (
          <EntryRows entries={day} onOpen={onOpen} onToggle={onToggle} />
        )}
      </View>
    </ScrollView>
  );
}

/** «время — дело» rows (`.blk2`): the month's day list, and the whole calendar at large font / ≤ 340 dp (§6). */
export function EntryRows({
  entries,
  onOpen,
  onToggle,
  large,
}: {
  entries: CalEntry[];
  onOpen: (e: CalEntry) => void;
  onToggle: (e: CalEntry) => void;
  large?: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const c = theme.colors;
  return (
    <View>
      {entries.map((e, i) => (
        <Pressable
          key={e.key}
          testID={`cal-row-${e.key}`}
          accessibilityRole="button"
          accessibilityLabel={`${e.start !== null ? hhmm(e.start) : t('cal.all_day_short')}. ${e.title}`}
          onPress={() => onOpen(e)}
          style={({ pressed }) => [
            { flexDirection: 'row', gap: 12, alignItems: 'stretch', minHeight: large ? 68 : 54, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.line },
            pressedStyle(pressed),
          ]}
        >
          <AppText
            nativeID="v5-one-line"
            numberOfLines={1}
            style={{ width: GRID.timeColumn, paddingTop: large ? 24 : 19, fontFamily: theme.type.headline.fontFamily, fontSize: 14, lineHeight: 16, color: c.ink2, fontVariant: ['tabular-nums'] }}
          >
            {e.start !== null ? hhmm(e.start) : ''}
          </AppText>
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {e.kind === 'reminder' ? (
              <Bell size={22} color={c.ink} strokeWidth={theme.icon.strokeWidth} />
            ) : e.kind === 'task' ? (
              <Pressable testID={`cal-row-check-${e.key}`} accessibilityRole="checkbox" accessibilityState={{ checked: e.done }} accessibilityLabel={e.title} onPress={() => onToggle(e)} hitSlop={11}>
                <CheckMark checked={e.done} waiting={e.pending} />
              </Pressable>
            ) : null}
            <AppText
              numberOfLines={1}
              style={[theme.type.headline, { flex: 1, color: e.done ? c.ink3 : c.ink, textDecorationLine: e.done ? 'line-through' : 'none' }]}
            >
              {e.title}
            </AppText>
            {e.duration ? <AppText variant="footnote" style={{ color: c.ink3 }}>{durText(t, e.duration)}</AppText> : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  head: { width: `${100 / 7}%`, height: 24, alignItems: 'center', justifyContent: 'center' },
  cell: { width: `${100 / 7}%`, height: 50, alignItems: 'center', gap: 3, paddingTop: 4 },
  num: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', gap: 3, height: 5 },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  sec: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 6 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});
