import { router, useFocusEffect } from 'expo-router';
import { Search } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useShallow } from 'zustand/react/shallow';

import { dayOffset, timeText } from '@/alarms/format';
import { upcoming } from '@/alarms/plan';
import { useAlarms } from '@/alarms/store';
import type { SuggestionOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { PendingAnswerCard } from '@/components/PendingAnswerCard';
import { useMinuteClock, useMissed } from '@/components/ReminderLists';
import { EntryCard } from '@/components/calendar/EntryCard';
import { dateText } from '@/components/calendar/parts';
import { categoryLook } from '@/components/page/expenseColors';
import { DateButton } from '@/components/today/DateButton';
import { DayPickerSheet } from '@/components/today/DayPickerSheet';
import { FirstPhrases, RecentSaved } from '@/components/today/EmptyToday';
import { NextUp } from '@/components/today/NextUp';
import { ComingRows, TodayPlan } from '@/components/today/TodayPlan';
import { TodayTiles } from '@/components/today/TodayTiles';
import { useReducedMotion } from '@/components/ui/motion';
import { PlaceScreen } from '@/components/ui/PlaceScreen';
import { moveEntry, setEntryDone } from '@/calendar/service';
import { calState } from '@/calendar/store';
import { addDaysIso, minutesOf as minuteOfDay } from '@/calendar/time';
import { useCalendarEntries } from '@/calendar/useEntries';
import { bars, board, liveEntries } from '@/expenses/feed';
import { useExpenses } from '@/expenses/store';
import { ensureTemplatePage } from '@/pages/service';
import { useFeatures } from '@/store/features';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { selectSortedPages, usePages } from '@/store/pages';
import { recordTitle } from '@/records/format';
import { useAllRecords, usePageEntries } from '@/records/useRecords';
import { changeTask } from '@/tasks/edit';
import { localDate } from '@/tasks/rows';
import { doneAt, isDone, liveTasks, pageForList, setDone } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { firstSteps } from '@/today/empty';
import { markMissedDone } from '@/today/missed';
import { canSayYes, refreshToday, sayNo, sayYes, useToday, visibleSuggestions } from '@/today/service';
import { todPeriod, todPhrase } from '@/today/timeOfDay';
import {
  comingDay,
  lateWithAhead,
  dayPlanParts,
  dayRows,
  leftToday,
  nextUpExtra,
  nextUpOf,
  planLimit,
  todayBottom,
  type PlanRow,
  type UntimedTodo,
} from '@/today/v6';
import { reducedMotionFade, todayMotion, useTheme } from '@/theme';

const DAY = 86_400_000;

/**
 * S06 «Сегодня» v6 (today-v6.md §3 option A, today-v6-acceptance.md; Ф-92…Ф-94). One frame in every period:
 * the yellow sheet = the date button («Другой день»), the 2-line phrase and the «Дальше» card (the way into the
 * calendar); the paper = «План» (by the time of day), at night «Будильник», the two tiles «Потрачено» / «Купить», one
 * tip. Another day always opens in the calendar «Дела → День» (Ф-93), back by Ф-91. Everything is counted from what
 * the phone holds before the first frame (offline, «Без ИИ»); `GET /today` adds the tip.
 */
export default function TodayScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const reduced = useReducedMotion();
  const noAi = useOnboarding(selectNoAi);
  const startedAt = useOnboarding((s) => s.openedAt ?? s.doneAt);
  const features = useFeatures((f) => f.today);
  const shopping = useFeatures((f) => f.shopping);
  const pages = usePages(useShallow(selectSortedPages));
  const expenses = useExpenses(useShallow((s) => ({ entries: s.entries, edits: s.edits, categories: s.categories })));
  const now = useMinuteClock();
  const missed = useMissed(now);
  const last = useToday((s) => s.last);
  const answered = useToday((s) => s.answered);
  const tasks = useTasks((s) => s.tasks);
  const ticks = useTasks((s) => s.ticks);
  const alarmSrc = useAlarms(useShallow((s) => ({ reminders: s.reminders, fires: s.fires, local: s.local, deviceId: s.deviceId })));
  const records = useAllRecords();
  const notesPage = pages.find((p) => p.templateKey === 'notes');
  const noteEntries = usePageEntries(notesPage);

  useFocusEffect(
    useCallback(() => {
      void refreshToday();
    }, []),
  );

  const today = localDate(now);
  const dayStart = new Date(`${today}T00:00:00`).getTime();
  const nowMin = minuteOfDay(now);
  const week = addDaysIso(today, 7);
  // Ф-89: what the calendar shows for today … +7 (timed to-dos, reminders, all-day to-dos), one source for all.
  const entries = useCalendarEntries(today, week);
  const timedToday = useMemo(() => entries.filter((e) => e.date === today && !e.allDay && e.start !== null), [entries, today]);

  // --- the period (§6.2): from the clock at once; a change while the screen is touched waits for 2 s of quiet ---
  const computed = todPeriod({ now: nowMin, today: timedToday });
  const [period, setPeriod] = useState(computed);
  const touchedAt = useRef(0);
  const latest = useRef(computed);
  useEffect(() => {
    latest.current = computed;
  });
  useEffect(() => {
    if (computed === period) return;
    let id: ReturnType<typeof setTimeout>;
    const tryNow = () => {
      const wait = touchedAt.current + todayMotion.idleBeforeChange - Date.now();
      if (wait > 0) id = setTimeout(tryNow, wait);
      else setPeriod(latest.current);
    };
    tryNow();
    return () => clearTimeout(id);
  }, [computed, period]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setPeriod(latest.current);
    });
    return () => sub.remove();
  }, []);
  const touch = useCallback(() => {
    touchedAt.current = Date.now();
  }, []);
  const fade = useSharedValue(1);
  const shownPeriod = useRef(period);
  useEffect(() => {
    if (shownPeriod.current === period) return;
    shownPeriod.current = period;
    fade.set(0);
    fade.set(withTiming(1, { duration: reduced ? reducedMotionFade : todayMotion.periodFade }));
  }, [period, fade, reduced]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  // --- to-dos without a time: a day ≤ today or no day; open, or ticked today ---
  const untimed: UntimedTodo[] = liveTasks(tasks, 'todo')
    .filter((x) => !x.start_at && (!x.due_date || x.due_date <= today))
    .filter((x) => !isDone(x, ticks) || doneAt(x, ticks) >= dayStart)
    .map((x) => ({ id: x.id, title: x.title, due_date: x.due_date, done: isDone(x, ticks), created_at: x.created_at }));
  const missedByOcc = new Map(missed.map((r) => [`${r.reminderId}|${r.at}`, r.key]));
  // Review 1 Р2: missed rings of the last 24 h with an earlier date («вчера в 22:00 оплатить свет») stay in «Прошло».
  const earlier = missed.filter((r) => r.at >= now - DAY && localDate(r.at) < today);
  const parts = dayPlanParts({ nowMin, today, entries, untimed, missed: missedByOcc, earlier, yesterday: t('today6.yesterday') });
  // Review 1 Р1: the evening / the night before midnight with timed things still ahead today keeps «План» as in the day.
  const late = lateWithAhead(period, nowMin, parts.ahead.length);
  const left = leftToday({ nowMin, today, entries, untimed });
  const coming = comingDay(today, nowMin, period);
  const comingRows = dayRows(entries, coming).filter((e) => coming !== today || e.allDay || (e.start ?? 0) > nowMin);
  const weekdayOf = (iso: string, style: 'long' | 'short') => {
    try {
      return new Date(`${iso}T12:00:00`).toLocaleDateString(i18n.language, { weekday: style });
    } catch {
      return iso;
    }
  };
  const comingTitle = t('today6.tomorrow', { day: weekdayOf(coming, 'long') });

  // --- the phrase (§3.1) ---
  const anyToday = timedToday.length + untimed.length > 0;
  let nearestDay: string | null = null;
  for (let d = addDaysIso(today, 1); d <= week && !nearestDay; d = addDaysIso(d, 1)) if (entries.some((e) => e.date === d && !e.done)) nearestDay = d;
  const nearestWord = nearestDay ? (nearestDay === addDaysIso(today, 1) ? t('rem.tomorrow').toLocaleLowerCase() : weekdayOf(nearestDay, 'long')) : null;
  const allToday = timedToday.length + untimed.length;
  const doneToday = timedToday.filter((e) => e.done).length + untimed.filter((x) => x.done).length;
  const phrase = todPhrase(
    period,
    {
      all: allToday,
      done: doneToday,
      ahead: parts.ahead.length + parts.untimed.length,
      coming: dayRows(entries, coming).length,
      emptyToday: !anyToday,
      nearest: nearestWord,
      lateAhead: late,
    },
    t,
  );

  // --- «Дальше» ---
  const next = nextUpOf({ nowMin, today, period, entries, anyDoneToday: doneToday > 0 });

  // --- money and shopping (§3.5) ---
  const live = liveEntries(expenses.entries, expenses.edits);
  // The tile shows one sum in ₸: only today's spending in tenge counts (other currencies stay in «Расходы»).
  const todayRows = live.filter((e) => e.spent_on === today && e.direction === 'expense' && e.currency === 'KZT');
  const todayBoard = board(todayRows, { from: today, to: today }, expenses.categories);
  const spentMinor = todayBoard.main?.currency === 'KZT' ? todayBoard.main.total : 0n;
  const spentParts = bars(todayBoard, expenses.categories, i18n.language, t('exp.no_category')).map((b) => ({
    key: b.key ?? 'none',
    title: b.title,
    share: b.share,
    color: categoryLook(theme, b.key).color,
  }));
  const toBuy = shopping ? liveTasks(tasks, 'shopping').filter((x) => !isDone(x, ticks)) : [];

  // --- the tip (R-35, Ф-42 limits as before) ---
  const shown = visibleSuggestions(last, answered);
  const ageDays = startedAt ? (now - Date.parse(startedAt)) / DAY : 0;
  const tipAllowed = !noAi && features.tips_per_day > 0 && (features.tips_days === 0 || ageDays < features.tips_days);
  // Review 1 Р3: proposals (R-35) after the tiles in the tip's look; off on the beta (`today.proposals`, Ф-42), code kept.
  // Proposals first (the server sends ≤ 2), then the tip: at most 2 lines together.
  const proposals = noAi || !features.proposals ? [] : shown.proposals.slice(0, 2);
  const tip = tipAllowed && proposals.length < 2 ? shown.tip : null;
  const lines = [...proposals, ...(tip ? [tip] : [])].slice(0, 2);

  // --- at night: the alarm of the coming morning, when one is set ---
  const alarmRing =
    period === 'night'
      ? upcoming({ ...alarmSrc, now }, 14 * 60 * 60_000).find((r) => r.level === 'alarm' && localDate(r.fireAt) === coming)
      : undefined;

  // --- an empty today (Ф-84 «Сводка»): first phrases, the nearest day, recently saved ---
  // No timed things today (any period but night): the Ф-84 «Сводка». Its «План» holds only the to-dos without a time and
  // is drawn as in the day (with «Прошло»), also in the evening — not «Осталось с сегодня» (review 1, accepted).
  const emptyToday = timedToday.length === 0 && period !== 'night';
  const hasExpense = live.length > 0;
  const hasReminder = Object.keys(alarmSrc.reminders).length > 0 || liveTasks(tasks, 'todo').length > 0;
  const hasRecord = (records ?? []).length > 0;
  // QA v5-device-3 J5: loading is not empty — «Три первые фразы» and «Недавно сохранили» wait for the records.
  const recordsLoading = records === null;
  const steps = firstSteps({ ageDays, note: hasRecord, reminder: hasReminder, expense: hasExpense });
  const nearRows = nearestDay ? dayRows(entries, nearestDay).filter((e) => !e.done) : [];
  let nearTitle = '';
  if (nearestDay) {
    if (nearestDay === addDaysIso(today, 1)) nearTitle = t('today6.tomorrow', { day: weekdayOf(nearestDay, 'long') });
    else {
      try {
        const full = new Date(`${nearestDay}T12:00:00`).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' });
        nearTitle = full.charAt(0).toUpperCase() + full.slice(1);
      } catch {
        nearTitle = weekdayOf(nearestDay, 'long');
      }
    }
  }
  const recentRows = [...(noteEntries ?? [])]
    .sort((a, b) => b.record.createdAt - a.record.createdAt)
    .slice(0, 2)
    .map(({ record: r }) => {
      const off = dayOffset(r.createdAt, now);
      let when: string;
      try {
        when =
          off === 0
            ? timeText(r.createdAt)
            : off === -1
              ? t('today.since_yesterday').replace(/^с\s/u, '')
              : off > -7
                ? weekdayOf(localDate(r.createdAt), 'short').replace(/\.$/u, '')
                : new Date(r.createdAt).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' });
      } catch {
        when = timeText(r.createdAt);
      }
      return { id: r.id, title: recordTitle(r, t), when };
    });

  // --- where taps go (§4) ---
  const tasksPage = pages.find((p) => p.templateKey === 'tasks');
  const [card, setCard] = useState<PlanRow | null>(null);
  const cardEntry = card ? (entries.find((e) => e.key === card.entry.key) ?? card.entry) : null;
  const openRow = (r: PlanRow) => {
    if (r.kind === 'reminder') return router.push({ pathname: '/reminder-new', params: { text: r.title, editId: r.entry.id } });
    setCard(r);
  };
  const toggle = (r: PlanRow, done: boolean) => {
    if (r.kind === 'todo') void setDone(r.entry.id, done);
    else void setEntryDone(r.entry, done);
  };
  const markDone = (r: PlanRow) => {
    if (r.kind === 'reminder') {
      const row = missed.find((x) => x.key === r.missedKey);
      if (row) void markMissedDone(row, t);
      return;
    }
    toggle(r, true);
  };
  const tomorrow = addDaysIso(today, 1);
  const toTomorrow = (r: PlanRow) => {
    if (r.entry.start !== null && r.kind !== 'todo') void moveEntry(r.entry, { date: tomorrow, start: r.entry.start, duration: r.entry.duration });
    else void changeTask(r.entry.id, { due_date: tomorrow }, t('todayTime.moved_tomorrow', { title: r.title }));
  };
  // §4.4: «Все дела ›» and «Ещё N ›» open «Дела» as the list (never the last calendar view).
  const openTaskList = () => {
    calState().set({ view: 'list', date: null });
    if (tasksPage) router.navigate({ pathname: '/page/[id]', params: { id: tasksPage.id } });
  };
  // §4.1 / §4.3: the calendar «День» on the date; back by Ф-91 (another day → the calendar on today → «Сегодня»).
  const openCalendar = (d: string) => {
    if (!tasksPage) return;
    calState().set({ view: 'day', date: d === today ? null : d });
    router.navigate({ pathname: '/page/[id]', params: { id: tasksPage.id } });
  };
  const openExpenses = () =>
    void ensureTemplatePage('expenses').then((p) => {
      if (p) router.navigate({ pathname: '/page/[id]', params: { id: p.id } });
    });
  const openShopping = () => {
    const p = pageForList('shopping');
    if (p && p.templateKey !== 'tasks') router.navigate({ pathname: '/page/[id]', params: { id: p.id } });
    else openTaskList();
  };
  const [picker, setPicker] = useState(false);

  // --- the sheet: «Пт, 20 ноября ▾» and the strip's «пт, 20 нояб.» ---
  const dateLabel = dateText(i18n.language, today);
  let longDate = dateLabel;
  let stripDate = dateLabel;
  try {
    const d = new Date(now).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' });
    longDate = d.charAt(0).toUpperCase() + d.slice(1);
    stripDate = new Date(now).toLocaleDateString(i18n.language, { weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    // the short form stays
  }

  const limit = planLimit(theme.m.width);
  const plan = (
    <TodayPlan
      // An empty today shows «План» of its to-dos without a time only (§3.4 «Сегодня пусто»), in any period but night.
      period={emptyToday ? 'day' : period}
      nowMin={nowMin}
      parts={parts}
      left={left}
      coming={comingRows}
      comingTitle={comingTitle}
      alarm={alarmRing ? timeText(alarmRing.fireAt) : null}
      limit={limit}
      onAll={openTaskList}
      onOpen={openRow}
      onToggle={toggle}
      onMarkDone={markDone}
      onTomorrow={toTomorrow}
      late={!emptyToday && late}
    />
  );

  return (
    <PlaceScreen
      testID="page-today"
      headerTestID="today-header"
      place="today"
      peek={['assistant', 'notes']}
      title={t('today.today')}
      metaNode={<DateButton label={dateLabel} longLabel={longDate} onPress={() => setPicker(true)} />}
      stripMeta={stripDate}
      phrase={phrase}
      sheetExtra={<NextUp state={next} onPress={openCalendar} />}
      sheetExtraHeight={nextUpExtra(theme.m)}
      askRoom
      onScroll={touch}
      contentContainerStyle={{ paddingBottom: todayBottom(theme.m) }}
      actions={[
        {
          key: 'search',
          icon: Search,
          label: t('today.search'),
          onPress: () => router.navigate('/search'),
          testID: 'today-search',
        },
      ]}
    >
      <PendingAnswerCard />
      {cardEntry ? <EntryCard entry={cardEntry} onClose={() => setCard(null)} /> : null}
      <DayPickerSheet
        visible={picker}
        today={today}
        onClose={() => setPicker(false)}
        onPick={(d) => {
          setPicker(false);
          openCalendar(d);
        }}
      />
      <Animated.View testID="today-list" onTouchStart={touch} style={fadeStyle}>
        {emptyToday ? (
          // Ф-84 «Сводка»: the to-dos without a time (as «План»), the first phrases, the nearest day, recently saved.
          <>
            {plan}
            {steps.show && !recordsLoading ? (
              <FirstPhrases
                first={untimed.length === 0}
                steps={[
                  { key: 'note', place: 'notes', done: hasRecord },
                  { key: 'rem', place: 'tasks', done: hasReminder },
                  { key: 'exp', place: 'expenses', done: hasExpense },
                ]}
              />
            ) : null}
            {nearestDay && nearRows.length > 0 ? (
              <ComingRows testID="today-nearest" first={untimed.length === 0 && !(steps.show && !recordsLoading)} title={nearTitle} rows={nearRows} />
            ) : null}
            <RecentSaved
              rows={recentRows}
              onOpen={(id) => router.navigate({ pathname: '/record/[id]', params: { id, ...(notesPage ? { from: notesPage.id } : {}) } })}
              onAll={() => {
                if (notesPage) router.navigate({ pathname: '/page/[id]', params: { id: notesPage.id } });
              }}
            />
            {/* J5: the room of the list while the records load (3 rows), no blocks that would swap. */}
            {recordsLoading ? <View testID="today-loading" style={{ height: theme.m.row * 3 }} accessibilityElementsHidden /> : null}
          </>
        ) : (
          plan
        )}
      </Animated.View>

      <TodayTiles spentMinor={spentMinor} parts={spentParts} toBuy={toBuy.map((x) => x.title)} shopping={shopping} onSpent={openExpenses} onBuy={openShopping} />

      {lines.length > 0 ? (
        <View testID="today-tips" style={{ marginTop: 18, gap: 12 }}>
          {lines.map((x) => (
            <TipRow key={x.id} s={x} />
          ))}
        </View>
      ) : null}
    </PlaceScreen>
  );
}

/**
 * §3.6: one line — the 9 dp assistant dot, the words 15 `ink2`, «Не сейчас» (600, underlined); after «Не сейчас» it does
 * not come back. «Да …» when the tip has one.
 */
function TipRow({ s }: { s: SuggestionOut }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const yes = canSayYes(s);
  const link = (testID: string, label: string, onPress: () => void) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => ({ minHeight: 32, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
    >
      <AppText
        nativeID="v5-one-line"
        numberOfLines={1}
        style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15, lineHeight: 18, textDecorationLine: 'underline', color: theme.colors.ink }}
      >
        {label}
      </AppText>
    </Pressable>
  );
  return (
    <View testID={`suggestion-${s.id}`} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <View style={{ width: 9, height: 9, borderRadius: 4.5, marginTop: 6, backgroundColor: theme.colors.place.assistant }} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ fontSize: 15, lineHeight: 21, color: theme.colors.ink2 }}>{s.text_ru.replace(/„/g, '«').replace(/[“”]/g, '»')}</AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 4 }}>
          {yes ? link(`suggestion-yes-${s.id}`, s.yes_label ?? t('common.yes'), () => void sayYes(s)) : null}
          {link(`suggestion-no-${s.id}`, s.no_label ?? t('common.not_now'), () => void sayNo(s))}
        </View>
      </View>
    </View>
  );
}
