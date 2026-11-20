import { Bell, ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { endOf, type CalEntry } from '@/calendar/entries';
import type { DayPeriod } from '@/calendar/period';
import { hhmm } from '@/calendar/time';
import { AppText } from '@/components/AppText';
import { durText } from '@/components/calendar/parts';
import { CheckMark } from '@/components/ui/Check';
import { SectionHead } from '@/components/ui/Leaf';
import { pressedStyle } from '@/components/ui/motion';
import { useTheme } from '@/theme';

/**
 * calendar-time.md §9.2 — the first block of the paper by the time of day (the morning keeps «План дня»):
 * day — «Дальше»: the next one as a 76 card (outline 2, «через 1 ч 40 мин») + ≤ 2 rows, then «Не отмечено» (past, not
 * done, ≤ 2, «На завтра»); evening — «Осталось с сегодня» (≤ 2, «На завтра») + «Завтра, {день}» (≤ 3 rows);
 * night — «Завтра, {день}», its first 2 rows. Heights are fixed by tokens (76, rows 54), so a period change never jumps.
 */
export function TimeOfDayBlock({
  period,
  now,
  today,
  tomorrow,
  tomorrowName,
  onCalendar,
  onOpen,
  onToggle,
  onTomorrow,
}: {
  period: Exclude<DayPeriod, 'morning'>;
  /** Minutes from midnight. */
  now: number;
  today: CalEntry[];
  tomorrow: CalEntry[];
  tomorrowName: string;
  onCalendar: (tomorrow: boolean) => void;
  onOpen: (e: CalEntry) => void;
  onToggle: (e: CalEntry) => void;
  onTomorrow: (e: CalEntry) => void;
}) {
  const { t } = useTranslation();
  const timed = today.filter((e) => e.start !== null).sort((a, b) => a.start! - b.start!);
  const tomorrowRows = [...tomorrow].sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.start ?? 0) - (b.start ?? 0));
  const cal = t('todayTime.calendar');

  if (period === 'night') {
    return (
      <View testID="today-tod-night">
        <SectionHead first title={t('todayTime.tomorrow', { day: tomorrowName })} link={cal} onLink={() => onCalendar(true)} linkTestID="today-calendar" />
        {tomorrowRows.slice(0, 2).map((e, i) => (
          <TimeRow key={e.key} e={e} first={i === 0} onOpen={onOpen} onToggle={onToggle} />
        ))}
      </View>
    );
  }

  if (period === 'evening') {
    const left = today.filter((e) => !e.done && e.kind === 'task' && (e.start === null || endOf(e) <= now));
    return (
      <View testID="today-tod-evening">
        {left.length > 0 ? (
          <View testID="today-left">
            <SectionHead first title={t('todayTime.left')} right={String(left.length)} />
            {left.slice(0, 2).map((e, i) => (
              <UnmarkedRow key={e.key} e={e} first={i === 0} withTime={false} onOpen={onOpen} onToggle={onToggle} onTomorrow={onTomorrow} />
            ))}
          </View>
        ) : null}
        <SectionHead first={left.length === 0} title={t('todayTime.tomorrow', { day: tomorrowName })} link={cal} onLink={() => onCalendar(true)} linkTestID="today-calendar" />
        {tomorrowRows.slice(0, 3).map((e, i) => (
          <TimeRow key={e.key} e={e} first={i === 0} onOpen={onOpen} onToggle={onToggle} />
        ))}
      </View>
    );
  }

  // Day: «Дальше» + «Не отмечено». Done ones are not shown.
  const ahead = timed.filter((e) => !e.done && endOf(e) > now);
  const next = ahead[0];
  const unmarked = timed.filter((e) => !e.done && e.kind === 'task' && endOf(e) <= now);
  return (
    <View testID="today-tod-day">
      <SectionHead first title={t('todayTime.next')} link={cal} onLink={() => onCalendar(false)} linkTestID="today-calendar" />
      {next ? <NextCard e={next} now={now} onOpen={onOpen} /> : null}
      {ahead.slice(1, 3).map((e, i) => (
        <TimeRow key={e.key} e={e} first={i === 0} onOpen={onOpen} onToggle={onToggle} style={{ marginTop: i === 0 ? 6 : 0 }} />
      ))}
      {unmarked.length > 0 ? (
        <View testID="today-unmarked">
          <SectionHead title={t('todayTime.unmarked')} right={String(unmarked.length)} />
          {unmarked.slice(0, 2).map((e, i) => (
            <UnmarkedRow key={e.key} e={e} first={i === 0} withTime onOpen={onOpen} onToggle={onToggle} onTomorrow={onTomorrow} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** `.nextc`: 76 high, `paper2`, a 2 `ink` outline, the time 800/20, the title 700/17, «через 1 ч 40 мин». */
function NextCard({ e, now, onOpen }: { e: CalEntry; now: number; onOpen: (e: CalEntry) => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const c = theme.colors;
  const going = e.start! <= now;
  const cap = going ? t('cal.now_word') : t('cal.in', { time: durText(t, e.start! - now) });
  return (
    <Pressable
      testID={`today-next-${e.key}`}
      accessibilityRole="button"
      accessibilityLabel={`${hhmm(e.start!)}. ${e.title}. ${cap}`}
      onPress={() => onOpen(e)}
      style={({ pressed }) => [
        { minHeight: 76, borderRadius: 18, backgroundColor: going ? c.ink : c.paper2, borderWidth: 2, borderColor: c.ink, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
        pressedStyle(pressed),
      ]}
    >
      <AppText nativeID="v5-one-line" maxFontSizeMultiplier={1.3} style={{ width: 58, fontFamily: theme.type.title.fontFamily, fontSize: 20, lineHeight: 22, color: going ? c.paper : c.ink, fontVariant: ['tabular-nums'] }}>
        {hhmm(e.start!)}
      </AppText>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText numberOfLines={1} style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 17, lineHeight: 21, color: going ? c.paper : c.ink }}>
          {e.title}
        </AppText>
        <AppText numberOfLines={1} variant="footnote" style={{ marginTop: 3, color: going ? c.paper : c.ink3, fontVariant: ['tabular-nums'] }}>
          {cap}
        </AppText>
      </View>
      <ChevronRight size={18} color={going ? c.paper : c.ink} strokeWidth={theme.icon.strokeWidth} />
    </Pressable>
  );
}

/** `.blk2`: the time in the 56 column (700/14 `ink2`), the check (or the bell of a reminder), the title. */
function TimeRow({ e, first, onOpen, onToggle, style }: { e: CalEntry; first: boolean; onOpen: (e: CalEntry) => void; onToggle: (e: CalEntry) => void; style?: object }) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <Pressable
      testID={`today-row-${e.key}`}
      accessibilityRole="button"
      accessibilityLabel={`${e.start !== null ? hhmm(e.start) : ''} ${e.title}`.trim()}
      onPress={() => onOpen(e)}
      style={({ pressed }) => [{ flexDirection: 'row', gap: 12, minHeight: theme.m.row, borderTopWidth: first ? 0 : 1, borderTopColor: c.line }, style ?? null, pressedStyle(pressed)]}
    >
      <AppText nativeID="v5-one-line" numberOfLines={1} style={{ width: 56, paddingTop: 19, fontFamily: theme.type.headline.fontFamily, fontSize: 14, lineHeight: 16, color: c.ink2, fontVariant: ['tabular-nums'] }}>
        {e.start !== null ? hhmm(e.start) : ''}
      </AppText>
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {e.kind === 'reminder' ? (
          <Bell size={22} color={c.ink} strokeWidth={theme.icon.strokeWidth} />
        ) : (
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: e.done }} accessibilityLabel={e.title} onPress={() => onToggle(e)} hitSlop={11}>
            <CheckMark checked={e.done} waiting={e.pending} />
          </Pressable>
        )}
        <AppText numberOfLines={1} style={[theme.type.headline, { flex: 1, color: c.ink }]}>
          {e.title}
        </AppText>
      </View>
    </Pressable>
  );
}

/** `.unm`: the check, the title 600/16, «было в 11:00», and «На завтра». */
function UnmarkedRow({
  e,
  first,
  withTime,
  onOpen,
  onToggle,
  onTomorrow,
}: {
  e: CalEntry;
  first: boolean;
  withTime: boolean;
  onOpen: (e: CalEntry) => void;
  onToggle: (e: CalEntry) => void;
  onTomorrow: (e: CalEntry) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const c = theme.colors;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: theme.m.row, borderTopWidth: first ? 0 : 1, borderTopColor: c.line }}>
      <Pressable testID={`today-unm-check-${e.key}`} accessibilityRole="checkbox" accessibilityState={{ checked: e.done }} accessibilityLabel={e.title} onPress={() => onToggle(e)} hitSlop={11}>
        <CheckMark checked={e.done} waiting={e.pending} />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => onOpen(e)} style={{ flex: 1, minWidth: 0 }}>
        <AppText numberOfLines={1} style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 16, lineHeight: 21, color: c.ink }}>
          {e.title}
        </AppText>
        {withTime && e.start !== null ? (
          <AppText variant="footnote" style={{ color: c.ink3 }}>
            {t('todayTime.was_at', { time: hhmm(e.start) })}
          </AppText>
        ) : null}
      </Pressable>
      <Pressable testID={`today-to-tomorrow-${e.key}`} accessibilityRole="button" onPress={() => onTomorrow(e)} hitSlop={10}>
        <AppText nativeID="v5-one-line" numberOfLines={1} style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 15, lineHeight: 18, color: c.ink, textDecorationLine: 'underline' }}>
          {t('todayTime.to_tomorrow')}
        </AppText>
      </Pressable>
    </View>
  );
}
