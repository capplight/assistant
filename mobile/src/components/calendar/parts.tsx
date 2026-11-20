import { ChevronLeft } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import type { CalView } from '@/calendar/nav';
import { onPlace, useTheme } from '@/theme';

import { AppText } from '../AppText';
import { pressedStyle } from '../ui/motion';

type T = (k: string, o?: Record<string, unknown>) => string;

/** «1 ч 40 мин», «30 мин», «2 ч» (i18n, tabular digits where drawn). */
export function durText(t: T, minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return t('cal.dur_m', { m });
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? t('cal.dur_h', { h }) : t('cal.dur_hm', { h, m: r });
}

/** «Пт, 20 ноября» / «пт, 20 нояб.» of a date on the person's language. */
export function dateText(lang: string, date: string, style: 'long' | 'short' = 'long'): string {
  try {
    const s = new Date(`${date}T12:00:00`).toLocaleDateString(lang, {
      weekday: 'short',
      day: 'numeric',
      month: style === 'long' ? 'long' : 'short',
    });
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch {
    return date;
  }
}

/** «Ноябрь» (the year only for another year: §13 п. 3, «Ноябрь 2026» was cut on 360 dp). */
export function monthTitle(lang: string, date: string, today: string): string {
  try {
    const d = new Date(`${date.slice(0, 7)}-15T12:00:00`);
    const other = date.slice(0, 4) !== today.slice(0, 4);
    const s = d.toLocaleDateString(lang, { month: 'long', ...(other ? { year: 'numeric' } : {}) });
    // «ноябрь 2027 г.» → «Ноябрь 2027»
    const clean = s.replace(/\s*г\.?$/u, '').replace(/\s*ж\.?$/u, '');
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  } catch {
    return date.slice(0, 7);
  }
}

/**
 * The calendar sheet's top row (calendar-time.html `.sh-top`): the ONE back arrow «‹» (40, margin −10), the month
 * 750/18 on the sheet ink. No «К сегодня», no path (Ф-91).
 */
export function CalSheetTop({ month, onBack, backLabel }: { month: string; onBack: () => void; backLabel: string }) {
  const theme = useTheme();
  const c = onPlace(theme.colors, 'tasks');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 40 }}>
      <Pressable
        testID="cal-back"
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        onPress={onBack}
        hitSlop={4}
        style={({ pressed }) => [
          { width: 48, height: 48, margin: -4, marginLeft: -14, alignItems: 'center', justifyContent: 'center', borderRadius: 24 },
          pressedStyle(pressed),
        ]}
      >
        <ChevronLeft size={22} color={c.ink} strokeWidth={theme.icon.strokeWidth} />
      </Pressable>
      <AppText
        testID="cal-month"
        numberOfLines={1}
        nativeID="v5-one-line"
        maxFontSizeMultiplier={1.3}
        style={{ fontFamily: theme.type.title.fontFamily, fontSize: 18, lineHeight: 20, color: c.ink, marginLeft: -2, flexShrink: 1 }}
      >
        {month}
      </AppText>
    </View>
  );
}

/** Height of the view switch row (`.r2`: 40 + 2 margin). */
export const VIEW_SWITCH_HEIGHT = 42;

/**
 * «Список · День · 3 дня · Месяц» (`.vseg.full`): four equal parts, 36 high, radius 18, a 1.5 outline in the sheet ink,
 * the chosen one filled with it (its words in the sheet colour). Changing the view adds no back step.
 */
export function ViewSwitch({ value, onChange, week }: { value: CalView; onChange: (v: CalView) => void; week: boolean }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const c = onPlace(theme.colors, 'tasks');
  const bg = theme.colors.place.tasks;
  const items: { key: CalView; label: string }[] = [
    { key: 'list', label: t('cal.view_list') },
    { key: 'day', label: t('cal.view_day') },
    { key: 'multi', label: week ? t('cal.view_week') : t('cal.view_multi') },
    { key: 'month', label: t('cal.view_month') },
  ];
  return (
    // Heights are minimums the capped labels (×1.3) never pass: the sheet keeps its token height.
    <View style={{ minHeight: 40, marginTop: 2, justifyContent: 'center' }}>
      <View
        testID="cal-views"
        accessibilityRole="tablist"
        accessibilityLabel={t('cal.views_a11y')}
        style={{ flexDirection: 'row', minHeight: 36, borderRadius: 18, borderWidth: 1.5, borderColor: c.ink, padding: 0.5 }}
      >
        {items.map((it) => {
          const on = it.key === value;
          return (
            <Pressable
              key={it.key}
              testID={`cal-view-${it.key}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={it.label}
              onPress={() => onChange(it.key)}
              style={{ flex: 1, minWidth: 0, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.ink : 'transparent', paddingHorizontal: 4 }}
            >
              <AppText
                numberOfLines={1}
                nativeID="v5-capped"
                maxFontSizeMultiplier={1.3}
                style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 15, lineHeight: 18, color: on ? bg : c.ink }}
              >
                {it.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
