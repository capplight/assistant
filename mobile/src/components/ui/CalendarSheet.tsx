import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { AppText } from '../AppText';
import { Button } from './Button';
import { Chip } from './Chip';
import { ChipRow } from './Leaf';
import { Sheet } from './Sheet';
import { useTheme } from '@/theme';

const DAY = 86_400_000;
const startOf = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();
const sameDay = (a: number, b: number) => startOf(a) === startOf(b);

/**
 * screens-v5-extra «Дело · календарь»: the month with ‹ ›, quick chips (Завтра · В пятницу · Через неделю), the
 * week from Monday; past days grey and not tappable, today ringed, the chosen one a black circle; «Готово · ср, 18
 * нояб.». The time of day stays as it was.
 */
export function CalendarSheet({
  value,
  now,
  onPick,
  onClose,
}: {
  value: number;
  now: number;
  onPick: (day: number) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const [chosen, setChosen] = useState(startOf(value));
  const [month, setMonth] = useState(() => {
    const d = new Date(value);
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  });
  const m = new Date(month);
  const today = startOf(now);
  const fmt = (ms: number, o: Intl.DateTimeFormatOptions) => {
    try {
      return new Date(ms).toLocaleDateString(i18n.language, o);
    } catch {
      return new Date(ms).toDateString();
    }
  };
  const title = fmt(month, { month: 'long', year: 'numeric' }).replace(/\s*г\.?$/u, '');
  // The grid: from the Monday on or before the 1st, six weeks at most (only the weeks of this month).
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  const daysIn = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((lead + daysIn) / 7) * 7;
  const grid = Array.from({ length: cells }, (_, i) => new Date(m.getFullYear(), m.getMonth(), 1 - lead + i).getTime());
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    fmt(new Date(2026, 10, 16 + i).getTime(), { weekday: 'short' }).replace(/\.$/u, ''),
  );
  const friday = today + ((5 - new Date(today).getDay() + 7) % 7 || 7) * DAY;
  const quick = [
    { key: 'tomorrow', label: t('rem.tomorrow'), day: today + DAY },
    { key: 'friday', label: t('rem.cal_friday'), day: friday },
    { key: 'week', label: t('rem.cal_week'), day: today + 7 * DAY },
  ];
  const pick = (d: number) => {
    setChosen(startOf(d));
    const dd = new Date(d);
    setMonth(new Date(dd.getFullYear(), dd.getMonth(), 1).getTime());
  };
  const shift = (step: number) => setMonth(new Date(m.getFullYear(), m.getMonth() + step, 1).getTime());
  const nav = (step: number, label: string) => (
    <Pressable
      testID={step < 0 ? 'cal-prev' : 'cal-next'}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => shift(step)}
      disabled={step < 0 && new Date(m.getFullYear(), m.getMonth(), 0).getTime() < today}
      style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}
    >
      {step < 0 ? (
        <ChevronLeft size={22} color={theme.colors.ink} />
      ) : (
        <ChevronRight size={22} color={theme.colors.ink} />
      )}
    </Pressable>
  );
  return (
    <Sheet visible testID="cal-sheet" onClose={onClose} place="tasks">
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {nav(-1, t('rem.cal_prev'))}
        <AppText
          accessibilityRole="header"
          style={{
            flex: 1,
            textAlign: 'center',
            fontFamily: theme.type.headline.fontFamily,
            fontSize: 18,
            lineHeight: 22,
          }}
        >
          {title.charAt(0).toUpperCase() + title.slice(1)}
        </AppText>
        {nav(1, t('rem.cal_next'))}
      </View>
      <ChipRow style={{ marginTop: 8, marginBottom: 10 }}>
        {quick.map((q) => (
          <Chip
            key={q.key}
            testID={`cal-quick-${q.key}`}
            label={q.label}
            variant={sameDay(q.day, chosen) ? 'selected' : 'neutral'}
            onPress={() => pick(q.day)}
          />
        ))}
      </ChipRow>
      <View style={{ flexDirection: 'row' }}>
        {weekdays.map((w) => (
          <AppText
            key={w}
            style={{
              flex: 1,
              textAlign: 'center',
              fontFamily: theme.type.sheetMeta.fontFamily,
              fontSize: 13,
              lineHeight: 16,
              color: theme.colors.ink3,
              paddingTop: 4,
              paddingBottom: 8,
            }}
          >
            {w}
          </AppText>
        ))}
      </View>
      <View testID="cal-grid" style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 2 }}>
        {grid.map((d) => {
          const inMonth = new Date(d).getMonth() === m.getMonth();
          const past = d < today;
          const on = d === chosen;
          const isToday = d === today;
          return (
            <View key={d} style={{ width: `${100 / 7}%`, paddingHorizontal: 2 }}>
              <Pressable
                testID={`cal-day-${new Date(d).getDate()}${inMonth ? '' : '-x'}`}
                accessibilityRole="button"
                accessibilityState={{ selected: on, disabled: past }}
                accessibilityLabel={fmt(d, { weekday: 'long', day: 'numeric', month: 'long' })}
                disabled={past}
                onPress={() => pick(d)}
                style={[
                  { height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
                  on
                    ? { backgroundColor: theme.colors.btn }
                    : isToday
                      ? { borderWidth: 1.5, borderColor: theme.colors.ink }
                      : null,
                ]}
              >
                <AppText
                  style={{
                    fontSize: 16,
                    lineHeight: 20,
                    fontVariant: ['tabular-nums'],
                    fontFamily: on ? theme.type.title.fontFamily : theme.type.bodyStrong.fontFamily,
                    color: on ? theme.colors.onBtn : past || !inMonth ? theme.colors.ink3 : theme.colors.ink,
                  }}
                >
                  {String(new Date(d).getDate())}
                </AppText>
              </Pressable>
            </View>
          );
        })}
      </View>
      <Button
        testID="cal-done"
        label={t('rem.cal_done', { day: fmt(chosen, { weekday: 'short', day: 'numeric', month: 'short' }) })}
        style={{ marginTop: 12 }}
        onPress={() => onPick(chosen)}
      />
    </Sheet>
  );
}
