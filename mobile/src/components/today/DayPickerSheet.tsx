import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import { addDaysIso, addMonths, isoDate } from '@/calendar/time';
import { useCalendarEntries } from '@/calendar/useEntries';
import { AppText } from '@/components/AppText';
import { pressedStyle } from '@/components/ui/motion';
import { Sheet } from '@/components/ui/Sheet';
import { dayPicker, useTheme } from '@/theme';

/** The days of a month's grid, Monday first: null = a cell outside the month (blank), 5 or 6 weeks. */
export function monthCells(first: string): (string | null)[] {
  const [y, m] = first.split('-').map(Number);
  const start = new Date(y!, (m ?? 1) - 1, 1, 12);
  const lead = (start.getDay() + 6) % 7;
  const days = new Date(y!, m ?? 1, 0, 12).getDate();
  const cells = Math.ceil((lead + days) / 7) * 7;
  return Array.from({ length: cells }, (_, i) => {
    const n = i - lead + 1;
    return n >= 1 && n <= days ? isoDate(new Date(y!, (m ?? 1) - 1, n, 12).getTime()) : null;
  });
}

/**
 * today-v6-acceptance.md §4 — «Другой день» (`BottomSheet` with the yellow 6 dp strip): «Сегодня» and «Завтра, сб»,
 * the month with ‹ › (44 cells, today filled `ink`, past days `ink3`, a 4 dp dot on a day with things) and the note
 * «День откроется в календаре…». A pick closes the sheet and opens the calendar «День» on that date. The scrim fades,
 * the sheet rises on a spring (UI thread, `Sheet`); a swipe down, the scrim and «назад» close it.
 */
export function DayPickerSheet({
  visible,
  today,
  onPick,
  onClose,
}: {
  visible: boolean;
  today: string;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} place="today" closeButton={false} scroll={false} testID="today-day-picker">
      {visible ? <PickerBody today={today} onPick={onPick} onClose={onClose} /> : null}
    </Sheet>
  );
}

function PickerBody({ today, onPick, onClose }: { today: string; onPick: (date: string) => void; onClose: () => void }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const c = theme.colors;
  const [month, setMonth] = useState(() => addMonths(today, 0));
  const cells = useMemo(() => monthCells(month), [month]);
  const last = cells.filter((x): x is string => x !== null).at(-1) ?? month;
  const entries = useCalendarEntries(month, last);
  const busy = useMemo(() => new Set(entries.filter((e) => !e.done).map((e) => e.date)), [entries]);
  const fmt = (date: string, o: Intl.DateTimeFormatOptions) => {
    try {
      return new Date(`${date}T12:00:00`).toLocaleDateString(i18n.language, o);
    } catch {
      return date;
    }
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const tomorrow = addDaysIso(today, 1);
  const title = cap(fmt(month, { month: 'long', year: 'numeric' }).replace(/\s*(г\.|ж\.)\s*$/u, ''));
  const weekdays = Array.from({ length: 7 }, (_, i) => cap(fmt(addDaysIso('2026-11-16', i), { weekday: 'short' }).replace(/\.$/u, '')));
  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(16)
        .failOffsetX([-24, 24])
        .onEnd((e) => {
          if (e.translationY > 64 || e.velocityY > 900) runOnJS(onClose)();
        }),
    [onClose],
  );
  const chip = (testID: string, label: string, date: string) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onPick(date)}
      style={({ pressed }) => [
        { minHeight: dayPicker.chip, borderRadius: dayPicker.chip / 2, borderWidth: 1.5, borderColor: c.ink, paddingHorizontal: 16, justifyContent: 'center' },
        pressedStyle(pressed),
      ]}
    >
      <AppText numberOfLines={1} maxFontSizeMultiplier={1.3} style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15, lineHeight: 18, color: c.ink }}>
        {label}
      </AppText>
    </Pressable>
  );
  const arrow = (step: -1 | 1) => (
    <Pressable
      testID={step < 0 ? 'today-day-picker-prev' : 'today-day-picker-next'}
      accessibilityRole="button"
      accessibilityLabel={step < 0 ? t('today6.pick_prev') : t('today6.pick_next')}
      onPress={() => setMonth((x) => addMonths(x, step))}
      style={({ pressed }) => [{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }, pressedStyle(pressed)]}
    >
      {step < 0 ? <ChevronLeft size={20} color={c.ink} strokeWidth={theme.icon.strokeWidth} /> : <ChevronRight size={20} color={c.ink} strokeWidth={theme.icon.strokeWidth} />}
    </Pressable>
  );
  return (
    <GestureHandlerRootView style={{ alignSelf: 'stretch' }}>
      <GestureDetector gesture={swipe}>
        <View accessibilityViewIsModal onAccessibilityEscape={onClose}>
          <AppText accessibilityRole="header" style={{ fontFamily: theme.type.section.fontFamily, fontSize: 18, lineHeight: 22, color: c.ink, paddingBottom: 12 }}>
            {t('today6.pick_title')}
          </AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {chip('today-pick-today', t('today6.pick_today'), today)}
            {chip('today-pick-tomorrow', t('today6.pick_tomorrow', { day: fmt(tomorrow, { weekday: 'short' }).replace(/\.$/u, '') }), tomorrow)}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, marginHorizontal: -12 }}>
            {arrow(-1)}
            <AppText testID="today-day-picker-month" accessibilityRole="header" style={{ flex: 1, textAlign: 'center', fontFamily: theme.type.section.fontFamily, fontSize: 15, lineHeight: 18, color: c.ink }}>
              {title}
            </AppText>
            {arrow(1)}
          </View>
          <View style={{ flexDirection: 'row' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {weekdays.map((w) => (
              <AppText key={w} maxFontSizeMultiplier={1.3} style={{ flex: 1, textAlign: 'center', fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 12, lineHeight: 16, color: c.ink3, paddingBottom: 4 }}>
                {w}
              </AppText>
            ))}
          </View>
          <View testID="today-day-picker-grid" style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 2 }}>
            {cells.map((d, i) => {
              if (!d) return <View key={`x${i}`} style={{ width: `${100 / 7}%`, height: dayPicker.cell }} />;
              const isToday = d === today;
              const past = d < today;
              const has = busy.has(d);
              const name = cap(fmt(d, { weekday: 'long', day: 'numeric', month: 'long' }));
              return (
                <Pressable
                  key={d}
                  testID={`today-pick-${d}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isToday }}
                  accessibilityLabel={has ? t('today6.pick_day_busy', { date: name }) : name}
                  onPress={() => onPick(d)}
                  style={({ pressed }) => [{ width: `${100 / 7}%`, minHeight: dayPicker.cell, alignItems: 'center', justifyContent: 'center' }, pressedStyle(pressed)]}
                >
                  <View style={{ width: dayPicker.day, height: dayPicker.day, borderRadius: dayPicker.day / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: isToday ? c.ink : 'transparent' }}>
                    <AppText
                      maxFontSizeMultiplier={1.3}
                      style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 16, lineHeight: 20, fontVariant: ['tabular-nums'], color: isToday ? c.paper : past ? c.ink3 : c.ink }}
                    >
                      {String(new Date(`${d}T12:00:00`).getDate())}
                    </AppText>
                  </View>
                  {has && !isToday ? (
                    <View testID={`today-pick-dot-${d}`} style={{ position: 'absolute', bottom: 2, width: dayPicker.dot, height: dayPicker.dot, borderRadius: dayPicker.dot / 2, backgroundColor: past ? c.ink3 : c.ink }} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
          <AppText variant="footnote" style={{ color: c.ink3, marginTop: 10 }}>
            {t('today6.pick_note')}
          </AppText>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}
