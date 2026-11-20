import { router, useFocusEffect } from 'expo-router';
import { Copy, Search, Share2 } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Pressable, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { dayOffset, dayText, timeText } from '@/alarms/format';
import { upcoming } from '@/alarms/plan';
import { act } from '@/alarms/service';
import { useAlarms } from '@/alarms/store';
import type { SuggestionOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { PendingAnswerCard } from '@/components/PendingAnswerCard';
import { useMinuteClock, useMissed } from '@/components/ReminderLists';
import { PageTiles, ShoppingLine } from '@/components/TodaySheet';
import { BackDate, DayFade, DayRows, EmptyDay, PlaceRows } from '@/components/today/DayView';
import { TimeOfDayBlock } from '@/components/today/TimeOfDay';
import { EntryCard } from '@/components/calendar/EntryCard';
import type { CalEntry } from '@/calendar/entries';
import { moveEntry, setEntryDone } from '@/calendar/service';
import { calState } from '@/calendar/store';
import { minutesOf as minuteOfDay } from '@/calendar/time';
import { useCalendarEntries } from '@/calendar/useEntries';
import { changeTask } from '@/tasks/edit';
import { todPeriod, todPhrase } from '@/today/timeOfDay';
import { FirstPhrases, RecentSaved, WeekStrip, weekStripHeight } from '@/components/today/EmptyToday';
import { useChrome } from '@/store/chrome';
import { useView } from '@/store/view';
import { Button } from '@/components/ui/Button';
import { CheckCircle } from '@/components/ui/Check';
import { DayPlan, type PlanItem } from '@/components/ui/DayPlan';
import { ButtonRow, Inset, Row, RowChevron, RowMeta, SectionHead } from '@/components/ui/Leaf';
import { PlaceScreen } from '@/components/ui/PlaceScreen';
import type { TimelineItem } from '@/components/ui/Timeline';
import { repeatsCount, visibleGroups } from '@/dedup/service';
import { useDedup } from '@/dedup/store';
import { addDays, formatMinor, periodOf } from '@/expenses/calc';
import { board, liveEntries } from '@/expenses/feed';
import { useExpenses } from '@/expenses/store';
import { ensureTemplatePage } from '@/pages/service';
import { budgetMinor, useBudget } from '@/store/budget';
import { useFeatures } from '@/store/features';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { selectSortedPages, usePages } from '@/store/pages';
import { recordTitle } from '@/records/format';
import { useAllRecords, usePageEntries } from '@/records/useRecords';
import { localDate } from '@/tasks/rows';
import { doneAt, isDone, liveTasks, pageForList, setDone } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { briefOf, dayPart } from '@/today/brief';
import { emptyPhrase, firstSteps, weekOf } from '@/today/empty';
import { markMissedDone } from '@/today/missed';
import { canSayYes, refreshToday, sayNo, sayYes, useToday, visibleSuggestions } from '@/today/service';
import { todayTiles } from '@/today/tiles';
import { plan as planGeometry, useTheme } from '@/theme';

const DAY = 86_400_000;
const MIN = 60_000;

/**
 * S06 «Сегодня» v2 — the morning briefing (design-system v2 §6, p14). Four blocks, always in this order:
 * 1. BriefCard: the status line, the headline of the day and a ≤3-line summary (a template from the numbers);
 * 2. two MetricTiles (v4): Потрачено · Новое — each opens its section;
 * 3. «План дня»: a Timeline of today's rings (missed in red, the next one within the hour is the one sun card with
 *    «Готово» / «+10 мин»), then «Дела» — the 3 nearest to-dos with a circle and «Все дела · N ›» (Дела left the tab
 *    bar for the centre «Помощник», VISION-2026-11);
 * 4. «Ждёт вас»: an answer waiting, repeats to merge, the week-1 tip / proposals (with their switches, Ф-42).
 * Built from what the phone holds (offline, «Без ИИ»); `GET /today` adds suggestions and its reminders / tasks.
 */
export default function TodayScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const noAi = useOnboarding(selectNoAi);
  const startedAt = useOnboarding((s) => s.openedAt ?? s.doneAt);
  const features = useFeatures((f) => f.today);
  const pages = usePages(useShallow(selectSortedPages));
  const expenses = useExpenses(useShallow((s) => ({ entries: s.entries, edits: s.edits, categories: s.categories })));
  const budget = useBudget(budgetMinor);
  const now = useMinuteClock();
  const missed = useMissed(now);
  const last = useToday((s) => s.last);
  const answered = useToday((s) => s.answered);
  const tasks = useTasks((s) => s.tasks);
  const ticks = useTasks((s) => s.ticks);
  const repeats = useDedup((s) => repeatsCount(visibleGroups(s.groups, s.decided)));
  const alarmSrc = useAlarms(
    useShallow((s) => ({ reminders: s.reminders, fires: s.fires, local: s.local, deviceId: s.deviceId })),
  );
  const records = useAllRecords();
  const notesPage = pages.find((p) => p.templateKey === 'notes');
  const noteEntries = usePageEntries(notesPage);

  // Ф-85 / QA v5-device-2 A8: a day of the week is shown in place (null = today). Back on the tab, or a second tap
  // on it, is today again; the week can be swiped to the next / previous one.
  const [chosen, setChosen] = useState<string | null>(null);
  const [weekShift, setWeekShift] = useState(0);
  const [dir, setDir] = useState(1);
  const todayTap = useChrome((s) => s.todayTap);
  const [seenTap, setSeenTap] = useState(todayTap);
  if (seenTap !== todayTap) {
    setSeenTap(todayTap);
    setChosen(null);
    setWeekShift(0);
  }
  useFocusEffect(
    useCallback(() => {
      void refreshToday();
      return () => {
        setChosen(null);
        setWeekShift(0);
      };
    }, []),
  );

  const part = dayPart(now);
  const today = localDate(now);
  const dayStart = new Date(`${today}T00:00:00`).getTime();

  // To-dos for today: not done with a day ≤ today (overdue first); ticked today stay, crossed out.
  const todos = liveTasks(tasks, 'todo')
    .filter((x) => !!x.due_date && x.due_date <= today && !x.start_at)
    .filter((x) => !isDone(x, ticks) || doneAt(x, ticks) >= dayStart)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
    .slice(0, 20);
  const rings = upcoming({ ...alarmSrc, now }, dayStart + DAY - now);
  const tomorrowRings = upcoming({ ...alarmSrc, now }, dayStart + 2 * DAY - now).filter(
    (r) => r.fireAt >= dayStart + DAY,
  );
  const tomorrowTodos = liveTasks(tasks, 'todo').filter((x) => x.due_date === addDays(today, 1) && !isDone(x, ticks) && !x.start_at);
  // Ф-89: timed to-dos (and reminders) of today and tomorrow, as the calendar counts them.
  const tomorrow = addDays(today, 1);
  const calEntries = useCalendarEntries(today, tomorrow);
  const timedToday = calEntries.filter((e) => e.date === today && e.start !== null);
  const timedTasksToday = timedToday.filter((e) => e.kind === 'task');
  const tomorrowEntries = calEntries.filter((e) => e.date === tomorrow);
  const [card, setCard] = useState<string | null>(null);
  const cardEntry = card ? (calEntries.find((e) => e.key === card) ?? null) : null;
  const openEntry = (e: CalEntry) => {
    if (e.kind === 'reminder') return router.push({ pathname: '/reminder-new', params: { text: e.title, editId: e.id } });
    setCard(e.key);
  };
  const toggleEntry = (e: CalEntry) => void setEntryDone(e, !e.done);
  const toTomorrow = (e: CalEntry) => {
    if (e.start !== null) void moveEntry(e, { date: tomorrow, start: e.start, duration: e.duration });
    else void changeTask(e.id, { due_date: tomorrow }, t('todayTime.moved_tomorrow', { title: e.title }));
  };
  // calendar-time.md §2 «Календарь ›»: the calendar «День» on the chosen date (the tab stays «Сегодня»).
  const openCalendar = (d: string) => {
    const p = pages.find((x) => x.templateKey === 'tasks');
    if (!p) return;
    calState().set({ view: 'day', date: d === today ? null : d });
    router.navigate({ pathname: '/page/[id]', params: { id: p.id } });
  };

  const total = todos.length + rings.length + missed.length + timedTasksToday.length;
  const done = todos.filter((x) => isDone(x, ticks)).length + timedTasksToday.filter((e) => e.done).length;

  // Money: this month, against the budget when one is set (Ф-55: «осталось в бюджете» only with a budget).
  const live = liveEntries(expenses.entries, expenses.edits);
  const month = board(live, periodOf('month', today), expenses.categories);
  const spentMinor = month.main?.currency === 'KZT' ? month.main.total : 0n;
  const todayRows = live.filter((e) => e.spent_on === today && e.direction === 'expense' && e.currency === 'KZT');
  const todayMinor = board(todayRows, { from: today, to: today }, expenses.categories).main?.total ?? 0n;
  const leftMinor = budget !== null ? budget - spentMinor : null;
  const spentText = spentMinor > 0n ? formatMinor(spentMinor) : null;

  const brief = briefOf(
    {
      part,
      total,
      done,
      ahead: rings.map((r) => ({
        title: r.title,
        time: timeText(r.fireAt),
        inMinutes: Math.round((r.fireAt - now) / MIN),
      })),
      spent: spentText,
      left: leftMinor !== null && leftMinor > 0n ? formatMinor(leftMinor) : null,
      tomorrow: tomorrowRings[0] ? { title: tomorrowRings[0].title, time: timeText(tomorrowRings[0].fireAt) } : null,
    },
    t,
  );

  // today.md «The briefing»: the server's words when it sent them (headline = the status line, lines = the headline + summary).
  const sb = last?.brief;
  if (sb && sb.part === part) {
    const kk = i18n.language === 'kk';
    const lines = (kk && sb.lines.kk) || sb.lines.ru;
    brief.status = (kk && sb.headline.kk) || sb.headline.ru;
    if (lines[0]) brief.headline = lines[0];
    brief.body = lines.slice(1).join(' ');
  }

  const pageOf = (k: 'tasks' | 'notes') => pages.find((p) => p.templateKey === k);
  const openPage = (k: 'tasks' | 'notes') => {
    const p = pageOf(k);
    if (p) router.navigate({ pathname: '/page/[id]', params: { id: p.id } });
  };
  const openExpenses = () =>
    void ensureTemplatePage('expenses').then((p) => {
      if (p) router.navigate({ pathname: '/page/[id]', params: { id: p.id } });
    });

  // «План дня»: missed (red) → the rings of today; the next one within the hour is «сейчас» (the sun card).
  const plan: TimelineItem[] = [];
  for (const row of missed) {
    const when = dayOffset(row.at, now) === 0 ? timeText(row.at) : `${dayText(row.at, now)}`;
    plan.push({
      key: `m-${row.key}`,
      testID: `missed-${row.key}`,
      time: when,
      title: row.title,
      meta: t('today.missed_meta'),
      label: t('missed.row', { time: when, title: row.title }),
      state: 'missed',
      onPress: () =>
        router.push({
          pathname: '/reminder-new',
          params: { text: row.title, missedKey: row.key, editId: row.reminderId },
        }),
    });
  }
  rings.forEach((r, i) => {
    const soon = i === 0 && r.fireAt - now <= 60 * MIN;
    plan.push({
      key: `r-${r.group}`,
      testID: `upcoming-${r.group}`,
      time: timeText(r.fireAt),
      title: r.title,
      meta: soon
        ? t('today.in_minutes', { n: Math.max(1, Math.round((r.fireAt - now) / MIN)) })
        : r.level === 'alarm'
          ? t('alarm.level_alarm')
          : undefined,
      state: soon ? 'now' : 'future',
      alarm: r.level === 'alarm',
      onDone: () => void act(r.group, 'done'),
      onSnooze: () => void act(r.group, 'snooze', 10),
    });
  });

  const tiles = features.tiles
    ? todayTiles({ pages, startedAt, now, today, server: last ? last.page_tiles : null, toBuy: [], expenses: live, t })
    : [];
  const shown = visibleSuggestions(last, answered);
  const proposals = noAi || !features.proposals ? [] : shown.proposals;
  const ageDays = startedAt ? (now - Date.parse(startedAt)) / DAY : 0;
  const tipAllowed = !noAi && features.tips_per_day > 0 && (features.tips_days === 0 || ageDays < features.tips_days);
  const tip = tipAllowed ? shown.tip : null;
  // Ф-49: «Купить: …» only while the shopping list is on (things to buy are to-dos in «Дела» otherwise).
  const shopping = useFeatures((f) => f.shopping);
  const toBuy = shopping ? liveTasks(tasks, 'shopping').filter((x) => !isDone(x, ticks)) : [];
  const shopPage = shopping ? pageForList('shopping') : undefined;
  const nearest = [...todos, ...tomorrowTodos.filter((x) => !todos.some((y) => y.id === x.id))].slice(0, 3);
  const tasksPage = pageOf('tasks');

  // v5 sheet: «Вторник, 17 ноября» / «вт, 17 нояб.»; the phrase = the headline + the counts (≤ 2 lines).
  let dateLine: string;
  let stripDate: string;
  try {
    const d = new Date(now).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' });
    dateLine = `${d.charAt(0).toUpperCase()}${d.slice(1)}`;
    stripDate = new Date(now).toLocaleDateString(i18n.language, { weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    dateLine = timeText(now);
    stripDate = dateLine;
  }
  const open = total - done;
  const counts = [
    open > 0 ? t('today.phrase_tasks', { count: open }) : null,
    rings.length > 0 ? t('today.phrase_rings', { count: rings.length }) : null,
  ]
    .filter(Boolean)
    .join(', ');
  // QA v5-device-1 C: the phrase is concrete and never ends in «….» — the headline without its own final dots,
  // then the numbers (and the missed ones first).
  const head =
    missed.length > 0
      ? t('today.phrase_missed', { count: missed.length })
      : `${brief.headline.replace(/[.…\s]+$/u, '')}.`;

  // QA B4/B5: the alarm risk lives in «Ещё» as a calm row; a tip is a row, not a grey plate.
  const waiting = repeats > 0 || proposals.length > 0 || !!tip;
  const minutesOf = (ms: number) => {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
  };
  const nowMin = minutesOf(now);
  // «План дня» blocks: missed rings (past, not done) and today's rings; the next one within the hour has its
  // «Готово» / «+10 мин» under the plan (they do not fit into a 40 dp block).
  // screens-v5-extra «Сегодня · пропущено»: missed rings are their own section on top, not plan blocks.
  const missedRows = plan.filter((p) => p.state === 'missed');
  const planItems: PlanItem[] = [
    ...rings.map((r) => ({
      id: `r-${r.group}`,
      testID: `upcoming-${r.group}`,
      start: minutesOf(r.fireAt),
      title: r.title,
    })),
    ...timedTasksToday.map((e) => ({
      id: e.key,
      testID: `plan-${e.key}`,
      start: e.start!,
      duration: e.duration ?? undefined,
      title: e.title,
      done: e.done,
      onPress: () => openEntry(e),
    })),
  ];
  const soon = plan.find((p) => p.state === 'now');
  const planEmpty = planItems.length === 0;
  // П2 (approved): with an empty plan «Не забыть» comes first.
  const notForgetFirst = planEmpty && missedRows.length === 0;
  // Ф-84 «Пустое „Сегодня“»: no plan today → «Сводка» + the week on the sheet (today-empty-options.html «Итог»).
  const emptyDay = planEmpty;
  const weekdayOf = (iso: string, style: 'long' | 'short') => {
    try {
      return new Date(`${iso}T00:00:00`).toLocaleDateString(i18n.language, { weekday: style });
    } catch {
      return iso;
    }
  };
  const load: Record<string, number> = {};
  for (const r of upcoming({ ...alarmSrc, now }, dayStart + 8 * DAY - now)) {
    const d = localDate(r.fireAt);
    if (d > today) load[d] = (load[d] ?? 0) + 1;
  }
  const openTodos = liveTasks(tasks, 'todo').filter((x) => !isDone(x, ticks));
  for (const x of openTodos) if (x.due_date && x.due_date > today) load[x.due_date] = (load[x.due_date] ?? 0) + 1;
  const todayLoad = openTodos.filter((x) => x.due_date === today).length;
  // «Не забыть» of an empty day: overdue → today → without a day (screens: «с вчера», «без срока»).
  const forgetList = [...todos, ...openTodos.filter((x) => !x.due_date)];
  const forgetOpen = forgetList.filter((x) => !isDone(x, ticks)).length;
  const ageDays0 = startedAt ? (now - Date.parse(startedAt)) / DAY : 0;
  const hasExpense = live.length > 0;
  const hasReminder = Object.keys(alarmSrc.reminders).length > 0 || liveTasks(tasks, 'todo').length > 0;
  const hasRecord = (records ?? []).length > 0;
  // QA v5-device-3 J5: loading is not empty — «Три первые фразы» (and anything that depends on the records) waits for them.
  const recordsLoading = records === null;
  const firstStepsRaw = firstSteps({ ageDays: ageDays0, note: hasRecord, reminder: hasReminder, expense: hasExpense });
  const steps = recordsLoading ? { ...firstStepsRaw, show: false } : firstStepsRaw;
  const blank = ageDays0 < 7 && records !== null && !hasRecord && !hasReminder && !hasExpense;
  // calendar-time.md §9: «Сегодня» by the time of day — the 2-line phrase of the period (when it has something to say).
  const period = todPeriod({ now: minuteOfDay(now), today: timedToday, tomorrowCount: tomorrowEntries.length });
  const todText = missed.length === 0 ? todPhrase(period, { now: minuteOfDay(now), today: timedToday, tomorrowCount: tomorrowEntries.length }, t) : null;
  const phrase = todText
    ? todText
    : emptyDay && missed.length === 0
      ? emptyPhrase({ today, blank, notForget: forgetOpen, load, weekday: (d) => weekdayOf(d, 'long') }, t)
      : counts
        ? `${head}\n${counts}.`
        : head;
  // --- the day view: what is on any day of the shown week ---
  const shownWeek = weekOf(addDays(today, 7 * weekShift));
  const weekEnd = shownWeek[6]!;
  const horizonDays = Math.max(8, Math.round((Date.parse(`${weekEnd}T00:00:00`) - dayStart) / DAY) + 2);
  const ringsAhead = horizonDays > 8 ? upcoming({ ...alarmSrc, now }, dayStart + horizonDays * DAY - now) : null;
  const allTodos = liveTasks(tasks, 'todo');
  const notesOf = (d: string) =>
    (records ?? []).filter((r) => r.kind !== 'ai_chat' && !r.deletedAt && localDate(r.createdAt) === d);
  const spentOf = (d: string) => live.filter((e) => e.spent_on === d && e.direction === 'expense');
  const doneOf = (d: string) => allTodos.filter((x) => isDone(x, ticks) && localDate(doneAt(x, ticks)) === d);
  const ringsOf = (d: string) =>
    (ringsAhead ?? upcoming({ ...alarmSrc, now }, dayStart + 8 * DAY - now)).filter((r) => localDate(r.fireAt) === d);
  const countOf = (d: string): number => {
    if (d === today) return todayLoad + rings.length;
    if (d < today) return doneOf(d).length + notesOf(d).length + spentOf(d).length;
    return ringsOf(d).length + openTodos.filter((x) => x.due_date === d).length;
  };
  const day = chosen && chosen !== today ? chosen : null;
  const week = shownWeek.map((d) => ({
    date: d,
    label: weekdayOf(d, 'short').replace(/\.$/u, ''),
    num: String(Number(d.slice(8))),
    name: weekdayOf(d, 'long'),
    // J5: a past day's dots count its records — none until they are read (never 2 → 3).
    count: recordsLoading && d < today ? 0 : countOf(d),
    past: d < today,
    today: d === today,
    selected: day === d,
  }));
  const openDay = (d: string) => {
    setDir(d > (day ?? today) ? 1 : -1);
    setChosen(d === today ? null : d);
  };
  const stepWeek = (step: -1 | 1) => {
    setDir(step);
    setWeekShift((w) => w + step);
  };
  const backToToday = () => {
    setDir((day ?? today) > today ? -1 : 1);
    setChosen(null);
    setWeekShift(0);
  };
  // Ф-91: the system back does what the arrow does — from another day back to today.
  useEffect(() => {
    if (!day) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      backToToday();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-armed per shown day
  }, [day]);
  const wd = day ? new Date(`${day}T00:00:00`).getDay() : 0;
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  let dayMeta = '';
  if (day) {
    try {
      dayMeta = cap(
        new Date(`${day}T00:00:00`).toLocaleDateString(i18n.language, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        }),
      );
    } catch {
      dayMeta = day;
    }
  }
  const dayPlanRows =
    day && day > today
      ? ringsOf(day).map((r) => ({ key: `dr-${r.group}`, time: timeText(r.fireAt), title: r.title }))
      : [];
  const dayUntimed =
    day && day > today
      ? openTodos.filter((x) => x.due_date === day).map((x) => ({ key: `dt-${x.id}`, time: '', title: x.title }))
      : [];
  const dayDone =
    day && day < today ? doneOf(day).map((x) => ({ key: `dd-${x.id}`, time: '', title: x.title, done: true })) : [];
  const daySaved = day && day < today ? notesOf(day).map((r) => ({ key: `ds-${r.id}`, title: recordTitle(r, t) })) : [];
  const daySpent =
    day && day < today
      ? spentOf(day).map((e) => ({
          key: `de-${e.id}`,
          title: e.note || t('exp.add_short'),
          meta: formatMinor(BigInt(Math.round(Number(e.amount) * 100))),
        }))
      : [];
  const dayDue = day && day < today ? allTodos.filter((x) => x.due_date === day) : [];
  const dayPhrase = !day
    ? null
    : day > today
      ? dayPlanRows.length + dayUntimed.length === 0
        ? t(`today.dv_free_${wd}`)
        : t('today.dv_future_phrase', {
            day: t(`today.dv_name_${wd}`),
            counts: [
              dayUntimed.length > 0 ? t('today.phrase_tasks', { count: dayUntimed.length }) : null,
              dayPlanRows.length > 0 ? t('today.phrase_rings', { count: dayPlanRows.length }) : null,
            ]
              .filter(Boolean)
              .join(', '),
          })
      : dayDone.length + daySaved.length + daySpent.length === 0
        ? t(`today.dv_past_${wd}`)
        : dayDue.length > 0
          ? t('today.dv_past_phrase', {
              day: t(`today.dv_name_${wd}`),
              done: dayDue.filter((x) => isDone(x, ticks)).length,
              all: dayDue.length,
            })
          : `${t(`today.dv_name_${wd}`)}.`;
  // «Добавить на пятницу…» in the strip while a future day is shown.
  const askHint = day && day > today ? t(`today.dv_ask_${wd}`) : null;
  useEffect(() => {
    useChrome.getState().setAskHint(askHint);
    return () => useChrome.getState().setAskHint(null);
  }, [askHint]);
  const dayContent = !day ? null : day > today ? (
    dayPlanRows.length + dayUntimed.length === 0 ? (
      <EmptyDay
        weekday={wd}
        past={false}
        onAdd={() => useView.getState().requestLine({ kind: 'text', text: t(`today.dv_input_${wd}`) })}
      />
    ) : (
      <View>
        <DayRows first title={t('today.dv_plan')} rows={dayPlanRows} testID="today-day-plan" />
        <DayRows
          first={dayPlanRows.length === 0}
          title={t('today.dv_untimed')}
          rows={dayUntimed}
          testID="today-day-untimed"
        />
      </View>
    )
  ) : dayDone.length + daySaved.length + daySpent.length === 0 ? (
    <EmptyDay weekday={wd} past onAdd={() => undefined} />
  ) : (
    <View>
      <DayRows first title={t('today.dv_done')} rows={dayDone} testID="today-day-done" />
      <PlaceRows
        first={dayDone.length === 0}
        title={t('today.dv_saved')}
        rows={daySaved}
        place="notes"
        testID="today-day-saved"
      />
      <PlaceRows
        first={dayDone.length + daySaved.length === 0}
        title={t('today.dv_spent')}
        rows={daySpent}
        place="expenses"
        testID="today-day-spent"
      />
    </View>
  );
  // The nearest day with things on it (tomorrow first), as «время — дело» rows.
  let nearDay: string | null = null;
  for (let i = 1; i <= 7 && !nearDay; i += 1) if ((load[addDays(today, i)] ?? 0) > 0) nearDay = addDays(today, i);
  const nearRows = nearDay
    ? [
        ...upcoming({ ...alarmSrc, now }, dayStart + 8 * DAY - now)
          .filter((r) => localDate(r.fireAt) === nearDay)
          .map((r) => ({ key: `nr-${r.group}`, time: timeText(r.fireAt), title: r.title })),
        ...openTodos
          .filter((x) => x.due_date === nearDay)
          .map((x) => ({ key: `nt-${x.id}`, time: '', title: x.title })),
      ].slice(0, 3)
    : [];
  let nearTitle = '';
  if (nearDay) {
    const wd = weekdayOf(nearDay, 'long');
    if (nearDay === addDays(today, 1)) nearTitle = `${t('rem.tomorrow')}, ${wd}`;
    else {
      try {
        const full = new Date(`${nearDay}T00:00:00`).toLocaleDateString(i18n.language, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        });
        nearTitle = full.charAt(0).toUpperCase() + full.slice(1);
      } catch {
        nearTitle = wd;
      }
    }
  }
  const recentRows = [...(noteEntries ?? [])]
    .sort((a, b) => b.record.createdAt - a.record.createdAt)
    .slice(0, 2)
    .map(({ record: r }) => {
      const off = dayOffset(r.createdAt, now);
      const when =
        off === 0
          ? timeText(r.createdAt)
          : off === -1
            ? t('today.since_yesterday').replace(/^с\s/u, '')
            : off > -7
              ? weekdayOf(localDate(r.createdAt), 'short').replace(/\.$/u, '')
              : new Date(r.createdAt).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' });
      return { id: r.id, title: recordTitle(r, t), when };
    });

  const tomorrowRows = [
    ...tomorrowRings.map((r) => ({ key: `tr-${r.group}`, time: timeText(r.fireAt), title: r.title })),
    ...tomorrowTodos
      .filter((x) => !nearest.some((y) => y.id === x.id))
      .map((x) => ({ key: `tt-${x.id}`, time: '', title: x.title })),
  ].slice(0, 3);

  const forgetRows = emptyDay ? forgetList.slice(0, 3) : nearest;
  const forgetCount = emptyDay ? forgetOpen : nearest.length;
  const forgetMore = Math.max(0, forgetCount - forgetRows.filter((x) => !isDone(x, ticks)).length);
  const notForget = (
    <>
      {forgetRows.length > 0 ? (
        <View testID="today-tasks">
          <SectionHead first={notForgetFirst} title={t('today.not_forget')} right={String(forgetCount)} />
          {forgetRows.map((x, i) => {
            const overdue = !!x.due_date && x.due_date < today;
            const meta = !x.due_date
              ? emptyDay
                ? t('today.no_due')
                : null
              : x.due_date === addDays(today, -1)
                ? t('today.since_yesterday')
                : overdue
                  ? t('today.overdue')
                  : x.due_date === addDays(today, 1)
                    ? t('today.tomorrow_meta')
                    : null;
            const checked = isDone(x, ticks);
            return (
              <Row
                key={x.id}
                first={i === 0}
                testID={`task-${x.id}`}
                accessibilityRole="button"
                onPress={() => openPage('tasks')}
                accessibilityLabel={x.title}
              >
                {/* QA A5: the circle sits at the column edge (its 48 target overhangs). */}
                <View style={{ marginHorizontal: -11 }}>
                  <TodoCheck id={x.id} checked={checked} title={x.title} />
                </View>
                <AppText
                  numberOfLines={1}
                  style={[
                    { flex: 1 },
                    checked ? { color: theme.colors.ink3, textDecorationLine: 'line-through' } : null,
                  ]}
                >
                  {x.title}
                </AppText>
                {meta ? <RowMeta>{meta}</RowMeta> : null}
              </Row>
            );
          })}
          {/* QA v5-device-2 B8: «Не забыть 6» with 3 rows — the rest is one row «Ещё 3 · Все дела ›». */}
          {forgetMore > 0 && tasksPage ? (
            <Row
              testID="today-forget-more"
              onPress={() => openPage('tasks')}
              accessibilityLabel={`${t('today.more_n', { count: forgetMore })}, ${t('today.all_tasks_short')}`}
            >
              <AppText style={{ flex: 1, fontFamily: theme.type.bodyStrong.fontFamily }} numberOfLines={1}>
                {`${t('today.more_n', { count: forgetMore })} · ${t('today.all_tasks_short')}`}
              </AppText>
              <RowChevron />
            </Row>
          ) : null}
        </View>
      ) : null}
    </>
  );

  return (
    <PlaceScreen
      testID="page-today"
      headerTestID="today-header"
      place="today"
      peek={['assistant', 'notes']}
      title={t('today.today')}
      meta={day ? undefined : dateLine}
      metaNode={day ? <BackDate label={dayMeta} onPress={backToToday} /> : undefined}
      stripMeta={stripDate}
      phrase={dayPhrase ?? phrase}
      sheetExtra={<WeekStrip days={week} onDay={openDay} onWeek={stepWeek} />}
      sheetExtraHeight={weekStripHeight(theme.m)}
      askRoom
      // today-day-view.html: the search stays on the right on another day too.
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
      {day ? (
        <DayFade dayKey={day} dir={dir}>
          {dayContent}
        </DayFade>
      ) : (
        <DayFade dayKey={`${today}:${period}`} dir={dir}>
          {missedRows.length > 0 ? (
            <View testID="today-missed" style={{ marginBottom: theme.space[3] }}>
              <SectionHead first title={t('today.missed_title')} right={String(missedRows.length)} />
              {missedRows.map((p, i) => {
                const row = missed[i]!;
                // QA v5-device-1 B1: a 56 dp time column with «09:00» only (a past day as «пн» above it), the title on
                // one line, «Сделано / Перенести» 38 high, no red.
                const otherDay = dayOffset(row.at, now) !== 0;
                let weekday = '';
                try {
                  weekday = new Date(row.at).toLocaleDateString(i18n.language, { weekday: 'short' });
                } catch {
                  weekday = '';
                }
                return (
                  <View
                    key={p.key}
                    testID={p.testID}
                    accessible
                    accessibilityLabel={p.label}
                    style={{
                      borderTopWidth: i === 0 ? 0 : 1,
                      borderTopColor: theme.colors.line,
                      paddingVertical: 10,
                      gap: 8,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 0 }}>
                      <View style={{ width: planGeometry.timeColumn }}>
                        {otherDay && weekday ? (
                          <AppText variant="footnote" numberOfLines={1}>
                            {weekday}
                          </AppText>
                        ) : null}
                        <AppText numberOfLines={1} nativeID="v5-one-line" style={theme.type.planTime}>
                          {timeText(row.at)}
                        </AppText>
                      </View>
                      <AppText numberOfLines={1} style={{ flex: 1 }}>
                        {p.title}
                      </AppText>
                    </View>
                    <ButtonRow style={{ paddingLeft: planGeometry.timeColumn }}>
                      <Button
                        testID={`missed-done-${row.key}`}
                        label={t('today.missed_done')}
                        size="small"
                        minHeight={38}
                        onPress={() => void markMissedDone(row, t)}
                      />
                      <Button
                        testID={`missed-move-${row.key}`}
                        label={t('today.move_btn')}
                        size="small"
                        minHeight={38}
                        variant="secondary"
                        onPress={p.onPress}
                      />
                    </ButtonRow>
                  </View>
                );
              })}
            </View>
          ) : null}

          {emptyDay ? (
            // Ф-84 «Сводка»: missed → «Не забыть» → (first days) «Три первые фразы» → the nearest day → «Недавно
            // сохранили». A section with nothing to show is not there (no empty blocks).
            <View testID="today-list">
              {/* A6: «План дня · Календарь ›» is always there; an empty day says «свободно» (the Ф-84 «Сводка» follows). */}
              {tasksPage ? (
                <View testID="today-plan-free">
                  <SectionHead first={missedRows.length === 0} title={t('today.plan')} link={t('todayTime.calendar')} onLink={() => openCalendar(today)} linkTestID="today-calendar" />
                  <Row first onPress={() => openCalendar(today)} accessibilityLabel={`${t('today.plan')}: ${t('todayTime.plan_free')}`}>
                    <AppText style={{ flex: 1, color: theme.colors.ink2 }}>{t('todayTime.plan_free')}</AppText>
                  </Row>
                </View>
              ) : null}
              {notForget}
              {steps.show ? (
                <FirstPhrases
                  first={missedRows.length === 0 && forgetRows.length === 0}
                  steps={[
                    { key: 'note', place: 'notes', done: hasRecord },
                    { key: 'rem', place: 'tasks', done: hasReminder },
                    { key: 'exp', place: 'expenses', done: hasExpense },
                  ]}
                />
              ) : null}
              {nearDay && nearRows.length > 0 ? (
                <View testID="today-nearest">
                  <SectionHead
                    first={missedRows.length === 0 && forgetRows.length === 0 && !steps.show}
                    title={nearTitle}
                    link={tasksPage ? t('today.all_tasks_short') : undefined}
                    onLink={() => openDay(nearDay)}
                    linkTestID="today-all-tasks"
                  />
                  {nearRows.map((r, i) => (
                    <Row key={r.key} first={i === 0}>
                      <AppText
                        numberOfLines={1}
                        nativeID="v5-one-line"
                        style={[theme.type.planTime, { width: planGeometry.timeColumn }]}
                      >
                        {r.time}
                      </AppText>
                      <AppText numberOfLines={1} style={{ flex: 1 }}>
                        {r.title}
                      </AppText>
                    </Row>
                  ))}
                </View>
              ) : null}
              <RecentSaved
                rows={recentRows}
                onOpen={(id) =>
                  router.navigate({
                    pathname: '/record/[id]',
                    params: { id, ...(notesPage ? { from: notesPage.id } : {}) },
                  })
                }
                onAll={() => openPage('notes')}
              />
              {/* J5: the room of the list while the records load (3 rows of 54), no blocks that would swap. */}
              {recordsLoading ? (
                <View testID="today-loading" style={{ height: theme.m.row * 3 }} accessibilityElementsHidden />
              ) : null}
              {!recordsLoading &&
              missedRows.length === 0 &&
              forgetRows.length === 0 &&
              !steps.show &&
              nearRows.length === 0 &&
              recentRows.length === 0 ? (
                <AppText testID="today-empty" variant="small">
                  {last?.empty && last.example
                    ? t('today.free_example', { example: last.example })
                    : t('today.plan_empty')}
                </AppText>
              ) : null}
            </View>
          ) : (
            <View testID="today-list">
              {period !== 'morning' ? (
                <TimeOfDayBlock
                  period={period}
                  now={nowMin}
                  today={calEntries.filter((e) => e.date === today)}
                  tomorrow={tomorrowEntries}
                  tomorrowName={weekdayOf(tomorrow, 'long')}
                  onCalendar={(next) => openCalendar(next ? tomorrow : today)}
                  onOpen={openEntry}
                  onToggle={toggleEntry}
                  onTomorrow={toTomorrow}
                />
              ) : (
                <>
              <SectionHead
                first={missedRows.length === 0}
                title={t('today.plan')}
                link={tasksPage ? t('todayTime.calendar') : undefined}
                onLink={() => openCalendar(today)}
                linkTestID="today-calendar"
                testID="today-plan-head"
              />
              <DayPlan testID="today-plan" items={planItems} now={nowMin} />
              {/* QA B6: one «now» — the black block in the plan; its «+10 мин» / «Готово» right under it, no second title. */}
              {soon ? (
                <ButtonRow
                  testID={soon.testID ? `${soon.testID}-now` : undefined}
                  style={{ paddingLeft: planGeometry.timeColumn, marginTop: 4 }}
                >
                  <Button
                    testID={soon.testID ? `${soon.testID}-snooze` : undefined}
                    label={t('today.snooze_10')}
                    variant="secondary"
                    size="small"
                    minHeight={38}
                    onPress={soon.onSnooze}
                  />
                  <Button
                    testID={soon.testID ? `${soon.testID}-done` : undefined}
                    label={t('today.done_btn')}
                    variant="primary"
                    size="small"
                    minHeight={38}
                    onPress={soon.onDone}
                  />
                </ButtonRow>
              ) : null}
                </>
              )}
              {notForget}
            </View>
          )}

          {toBuy.length > 0 ? (
            <ShoppingLine
              titles={toBuy.map((x) => x.title)}
              hint={shopPage ? t('today.shopping_hint') : undefined}
              onPress={
                shopPage ? () => router.navigate({ pathname: '/page/[id]', params: { id: shopPage.id } }) : undefined
              }
            />
          ) : null}

          {waiting ? (
            <View testID="today-waiting">
              {repeats > 0 || proposals.length > 0 ? <SectionHead title={t('today.waiting')} /> : null}
              {repeats > 0 ? (
                <Row
                  first
                  testID="waiting-repeats"
                  onPress={() => router.push('/duplicates')}
                  accessibilityLabel={t('today.repeats', { count: repeats })}
                >
                  <Copy size={22} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
                  <View style={{ flex: 1 }}>
                    <AppText>{t('today.repeats', { count: repeats })}</AppText>
                    <AppText variant="footnote">{t('today.repeats_hint')}</AppText>
                  </View>
                  <RowChevron />
                </Row>
              ) : null}
              <View style={{ gap: theme.space[2], marginTop: theme.space[2] }}>
                {proposals.map((s) => (
                  <SuggestionCard key={s.id} s={s} />
                ))}
                {tip ? <TipRow s={tip} /> : null}
              </View>
            </View>
          ) : null}

          {/* П3 (approved): no spending today → no «Потрачено сегодня». */}
          {todayMinor > 0n ? (
            <View testID="tile-spent">
              <SectionHead
                title={t('today.spent_today_title')}
                link={formatMinor(todayMinor)}
                onLink={openExpenses}
                testID="today-spent"
              />
              {leftMinor !== null ? (
                <AppText variant="footnote" color={leftMinor < 0n ? 'danger' : 'ink3'}>
                  {leftMinor >= 0n
                    ? t('today.budget_left', { sum: formatMinor(leftMinor) })
                    : t('today.budget_over', { sum: formatMinor(-leftMinor) })}
                </AppText>
              ) : null}
            </View>
          ) : null}

          {!emptyDay && period === 'morning' && tomorrowRows.length > 0 ? (
            <View testID="today-tomorrow">
              <SectionHead
                title={t('today.tomorrow')}
                link={tasksPage ? t('today.all_tasks_short') : undefined}
                onLink={() => openPage('tasks')}
              />
              {tomorrowRows.map((r, i) => (
                <Row key={r.key} first={i === 0}>
                  <AppText style={[theme.type.planTime, { width: 48 }]}>{r.time}</AppText>
                  <AppText numberOfLines={1} style={{ flex: 1 }}>
                    {r.title}
                  </AppText>
                </Row>
              ))}
            </View>
          ) : null}
          <PageTiles tiles={tiles} />
        </DayFade>
      )}
    </PlaceScreen>
  );
}

/** The 26 circle of a to-do (a tick works offline, with «Отменить»). */
function TodoCheck({ id, checked, title }: { id: string; checked: boolean; title: string }) {
  return (
    <CheckCircle testID={`task-check-${id}`} checked={checked} label={title} onChange={(v) => void setDone(id, v)} />
  );
}

/** A tip as one row (QA B5): its words, «Да …» when it has one and «Не сейчас» as links — no plate. */
/**
 * QA v5-device-2 B4: a tip is one calm card on paper2 (r16, padding 16) — the share icon, the words 15 ink2, the links
 * at the left edge of the words; no «Ждёт вас» heading over a single tip. After «Не сейчас» it does not come back.
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
        style={{
          fontFamily: theme.type.headline.fontFamily,
          fontSize: 15,
          lineHeight: 18,
          textDecorationLine: 'underline',
        }}
      >
        {label}
      </AppText>
    </Pressable>
  );
  return (
    <View
      testID={`suggestion-${s.id}`}
      style={{
        backgroundColor: theme.colors.paper2,
        borderRadius: 16,
        padding: 16,
        flexDirection: 'row',
        gap: 12,
        alignItems: 'flex-start',
      }}
    >
      <Share2 size={22} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
      <View style={{ flex: 1, gap: 6 }}>
        <AppText style={{ fontSize: 15, lineHeight: 21, color: theme.colors.ink2 }}>
          {s.text_ru.replace(/„/g, '«').replace(/[“”]/g, '»')}
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 4 }}>
          {yes ? link(`suggestion-yes-${s.id}`, s.yes_label ?? t('common.yes'), () => void sayYes(s)) : null}
          {link(`suggestion-no-${s.id}`, s.no_label ?? t('common.not_now'), () => void sayNo(s))}
        </View>
      </View>
    </View>
  );
}

/** A proposal or a tip: the text, [Да …] and [Не сейчас]. «Да» is never pre-focused or automatic. */
function SuggestionCard({ s }: { s: SuggestionOut }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const yes = canSayYes(s);
  return (
    <Inset testID={`suggestion-${s.id}`} style={{ gap: theme.space[3] }}>
      <AppText>{s.text_ru}</AppText>
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {yes ? (
          <Button
            testID={`suggestion-yes-${s.id}`}
            size="small"
            variant="primary"
            label={s.yes_label ?? t('common.yes')}
            onPress={() => void sayYes(s)}
          />
        ) : null}
        <Button
          testID={`suggestion-no-${s.id}`}
          size="small"
          variant="text"
          label={s.no_label ?? t('common.not_now')}
          onPress={() => void sayNo(s)}
        />
      </View>
    </Inset>
  );
}
