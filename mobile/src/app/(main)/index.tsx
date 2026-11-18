import { router, useFocusEffect } from 'expo-router';
import { Copy, Search } from 'lucide-react-native';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
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
import { FirstPhrases, RecentSaved, WeekStrip } from '@/components/today/EmptyToday';
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

  useFocusEffect(
    useCallback(() => {
      void refreshToday();
    }, []),
  );

  const part = dayPart(now);
  const today = localDate(now);
  const dayStart = new Date(`${today}T00:00:00`).getTime();

  // To-dos for today: not done with a day ≤ today (overdue first); ticked today stay, crossed out.
  const todos = liveTasks(tasks, 'todo')
    .filter((x) => !!x.due_date && x.due_date <= today)
    .filter((x) => !isDone(x, ticks) || doneAt(x, ticks) >= dayStart)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
    .slice(0, 20);
  const rings = upcoming({ ...alarmSrc, now }, dayStart + DAY - now);
  const tomorrowRings = upcoming({ ...alarmSrc, now }, dayStart + 2 * DAY - now).filter(
    (r) => r.fireAt >= dayStart + DAY,
  );
  const tomorrowTodos = liveTasks(tasks, 'todo').filter((x) => x.due_date === addDays(today, 1) && !isDone(x, ticks));

  const total = todos.length + rings.length + missed.length;
  const done = todos.filter((x) => isDone(x, ticks)).length;

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
  const steps = firstSteps({ ageDays: ageDays0, note: hasRecord, reminder: hasReminder, expense: hasExpense });
  const blank = ageDays0 < 7 && records !== null && !hasRecord && !hasReminder && !hasExpense;
  const phrase =
    emptyDay && missed.length === 0
      ? emptyPhrase({ today, blank, notForget: forgetOpen, load, weekday: (d) => weekdayOf(d, 'long') }, t)
      : counts
        ? `${head}\n${counts}.`
        : head;
  const week = weekOf(today).map((d) => ({
    date: d,
    label: weekdayOf(d, 'short').replace(/\.$/u, ''),
    num: String(Number(d.slice(8))),
    name: weekdayOf(d, 'long'),
    count: d === today ? todayLoad + rings.length : (load[d] ?? 0),
    past: d < today,
    today: d === today,
  }));
  const openDay = (d: string) => {
    if (!tasksPage) return;
    router.navigate({
      pathname: '/page/[id]',
      params: { id: tasksPage.id, ...(d > today ? { segment: 'soon' } : {}) },
    });
  };
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
      meta={dateLine}
      stripMeta={stripDate}
      phrase={phrase}
      sheetExtra={emptyDay ? <WeekStrip days={week} onDay={openDay} /> : undefined}
      askRoom
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
          {missedRows.length === 0 &&
          forgetRows.length === 0 &&
          !steps.show &&
          nearRows.length === 0 &&
          recentRows.length === 0 ? (
            <AppText testID="today-empty" variant="small">
              {last?.empty && last.example ? t('today.free_example', { example: last.example }) : t('today.plan_empty')}
            </AppText>
          ) : null}
        </View>
      ) : (
        <View testID="today-list">
          <SectionHead
            first={missedRows.length === 0}
            title={t('today.plan')}
            link={tasksPage ? t('today.all_tasks_short') : undefined}
            onLink={() => openPage('tasks')}
            linkTestID="today-all-tasks"
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
          <SectionHead title={t('today.waiting')} />
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

      {!emptyDay && tomorrowRows.length > 0 ? (
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
function TipRow({ s }: { s: SuggestionOut }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const yes = canSayYes(s);
  return (
    <View
      testID={`suggestion-${s.id}`}
      style={{ borderTopWidth: 1, borderTopColor: theme.colors.line, paddingVertical: 10, gap: 4 }}
    >
      <AppText variant="small">{s.text_ru.replace(/„/g, '«').replace(/[“”]/g, '»')}</AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {yes ? (
          <Button
            testID={`suggestion-yes-${s.id}`}
            size="small"
            variant="link"
            label={s.yes_label ?? t('common.yes')}
            onPress={() => void sayYes(s)}
          />
        ) : null}
        <Button
          testID={`suggestion-no-${s.id}`}
          size="small"
          variant="link"
          label={s.no_label ?? t('common.not_now')}
          onPress={() => void sayNo(s)}
        />
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
