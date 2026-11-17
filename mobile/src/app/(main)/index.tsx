import { router, useFocusEffect } from 'expo-router';
import { Copy, PhoneMissed, Search } from 'lucide-react-native';
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
import { AlarmRiskRow, useAlarmRisk } from '@/components/ReminderCards';
import { useMinuteClock, useMissed } from '@/components/ReminderLists';
import { PageTiles, ShoppingLine } from '@/components/TodaySheet';
import { Button } from '@/components/ui/Button';
import { CheckCircle } from '@/components/ui/Check';
import { DayPlan, type PlanItem } from '@/components/ui/DayPlan';
import { Inset, Row, RowChevron, RowMeta, SectionHead } from '@/components/ui/Leaf';
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
import { localDate } from '@/tasks/rows';
import { doneAt, isDone, liveTasks, pageForList, setDone } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { briefOf, dayPart } from '@/today/brief';
import { markMissedDone } from '@/today/missed';
import { canSayYes, refreshToday, sayNo, sayYes, useToday, visibleSuggestions } from '@/today/service';
import { todayTiles } from '@/today/tiles';
import { useTheme } from '@/theme';

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
  const alarmSrc = useAlarms(useShallow((s) => ({ reminders: s.reminders, fires: s.fires, local: s.local, deviceId: s.deviceId })));

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
  const tomorrowRings = upcoming({ ...alarmSrc, now }, dayStart + 2 * DAY - now).filter((r) => r.fireAt >= dayStart + DAY);
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
      ahead: rings.map((r) => ({ title: r.title, time: timeText(r.fireAt), inMinutes: Math.round((r.fireAt - now) / MIN) })),
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
      onPress: () => router.push({ pathname: '/reminder-new', params: { text: row.title, missedKey: row.key, editId: row.reminderId } }),
    });
  }
  rings.forEach((r, i) => {
    const soon = i === 0 && r.fireAt - now <= 60 * MIN;
    plan.push({
      key: `r-${r.group}`,
      testID: `upcoming-${r.group}`,
      time: timeText(r.fireAt),
      title: r.title,
      meta: soon ? t('today.in_minutes', { n: Math.max(1, Math.round((r.fireAt - now) / MIN)) }) : r.level === 'alarm' ? t('alarm.level_alarm') : undefined,
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
  const counts = [open > 0 ? t('today.phrase_tasks', { count: open }) : null, rings.length > 0 ? t('today.phrase_rings', { count: rings.length }) : null].filter(Boolean).join(', ');
  const phrase = counts ? `${brief.headline}\n${counts}.` : brief.headline;

  const risk = useAlarmRisk();
  const waiting = risk || missed.length > 0 || repeats > 0 || proposals.length > 0 || !!tip;
  const minutesOf = (ms: number) => {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
  };
  const nowMin = minutesOf(now);
  // «План дня» blocks: missed rings (past, not done) and today's rings; the next one within the hour has its
  // «Готово» / «+10 мин» under the plan (they do not fit into a 40 dp block).
  const planItems: PlanItem[] = [
    ...plan.filter((p) => p.state === 'missed').map((p, i) => ({
      id: p.key,
      testID: p.testID,
      label: p.label,
      start: missed[i] && dayOffset(missed[i]!.at, now) === 0 ? minutesOf(missed[i]!.at) : 0,
      title: p.title,
      onPress: p.onPress,
    })),
    ...rings.map((r) => ({ id: `r-${r.group}`, testID: `upcoming-${r.group}`, start: minutesOf(r.fireAt), title: r.title })),
  ];
  const soon = plan.find((p) => p.state === 'now');
  const tomorrowRows = [
    ...tomorrowRings.map((r) => ({ key: `tr-${r.group}`, time: timeText(r.fireAt), title: r.title })),
    ...tomorrowTodos.filter((x) => !nearest.some((y) => y.id === x.id)).map((x) => ({ key: `tt-${x.id}`, time: '', title: x.title })),
  ].slice(0, 3);

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
      askRoom
      actions={[{ key: 'search', icon: Search, label: t('today.search'), onPress: () => router.navigate('/search'), testID: 'today-search' }]}
    >
      <PendingAnswerCard />

      <View testID="today-list">
        <SectionHead
          first
          title={t('today.plan')}
          link={tasksPage ? t('today.all_tasks_short') : undefined}
          onLink={() => openPage('tasks')}
          linkTestID="today-all-tasks"
          testID="today-plan-head"
        />
        {planItems.length > 0 ? (
          <DayPlan testID="today-plan" items={planItems} now={nowMin} />
        ) : (
          <Inset testID="today-empty">
            <AppText variant="callout">{last?.empty && last.example ? t('today.free_example', { example: last.example }) : t('today.plan_empty')}</AppText>
          </Inset>
        )}
        {soon ? (
          <Row first testID={soon.testID ? `${soon.testID}-now` : undefined}>
            <AppText numberOfLines={2} style={{ flex: 1 }}>
              {soon.meta ? `${soon.meta} · ${soon.title}` : soon.title}
            </AppText>
            <Button testID={soon.testID ? `${soon.testID}-snooze` : undefined} label={t('today.snooze_10')} variant="text" size="small" onPress={soon.onSnooze} />
            <Button testID={soon.testID ? `${soon.testID}-done` : undefined} label={t('today.done_btn')} variant="primary" size="small" onPress={soon.onDone} />
          </Row>
        ) : null}

        {nearest.length > 0 ? (
          <View testID="today-tasks">
            <SectionHead title={t('today.not_forget')} right={String(nearest.length)} />
            {nearest.map((x, i) => {
              const overdue = !!x.due_date && x.due_date < today;
              const tomorrow = x.due_date === addDays(today, 1);
              const checked = isDone(x, ticks);
              return (
                <Row key={x.id} first={i === 0} testID={`task-${x.id}`} accessibilityRole="checkbox" onPress={() => void setDone(x.id, !checked)} accessibilityLabel={x.title}>
                  <TodoCheck id={x.id} checked={checked} title={x.title} />
                  <AppText numberOfLines={1} style={[{ flex: 1 }, checked ? { color: theme.colors.ink3, textDecorationLine: 'line-through' } : null]}>
                    {x.title}
                  </AppText>
                  {overdue || tomorrow ? <RowMeta>{overdue ? t('today.overdue') : t('today.tomorrow_meta')}</RowMeta> : null}
                </Row>
              );
            })}
          </View>
        ) : null}
      </View>

      {toBuy.length > 0 ? (
        <ShoppingLine
          titles={toBuy.map((x) => x.title)}
          hint={shopPage ? t('today.shopping_hint') : undefined}
          onPress={shopPage ? () => router.navigate({ pathname: '/page/[id]', params: { id: shopPage.id } }) : undefined}
        />
      ) : null}

      {waiting ? (
        <View testID="today-waiting">
          <SectionHead title={t('today.waiting')} />
          <AlarmRiskRow />
          {missed.slice(0, 2).map((row, i) => (
            <Row key={row.key} first={i === 0} testID={`waiting-missed-${row.key}`}>
              <PhoneMissed size={22} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
              <View style={{ flex: 1 }}>
                <AppText numberOfLines={2}>{row.title}</AppText>
                <AppText variant="footnote">{t('today.missed_meta')}</AppText>
              </View>
              <Button testID={`missed-done-${row.key}`} label={t('today.done_btn')} variant="text" onPress={() => void markMissedDone(row, t)} />
            </Row>
          ))}
          {repeats > 0 ? (
            <Row first={missed.length === 0} testID="waiting-repeats" onPress={() => router.push('/duplicates')} accessibilityLabel={t('today.repeats', { count: repeats })}>
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
            {tip ? <SuggestionCard s={tip} /> : null}
          </View>
        </View>
      ) : null}

      <View testID="tile-spent">
        <SectionHead
          title={t('today.spent_today_title')}
          link={formatMinor(todayMinor)}
          onLink={openExpenses}
          testID="today-spent"
        />
        {leftMinor !== null ? (
          <AppText variant="footnote" color={leftMinor < 0n ? 'danger' : 'ink3'}>
            {leftMinor >= 0n ? t('today.budget_left', { sum: formatMinor(leftMinor) }) : t('today.budget_over', { sum: formatMinor(-leftMinor) })}
          </AppText>
        ) : null}
      </View>

      {tomorrowRows.length > 0 ? (
        <View testID="today-tomorrow">
          <SectionHead title={t('today.tomorrow')} link={tasksPage ? t('today.all_tasks_short') : undefined} onLink={() => openPage('tasks')} />
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
  return <CheckCircle testID={`task-check-${id}`} checked={checked} label={title} onChange={(v) => void setDone(id, v)} />;
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
          <Button testID={`suggestion-yes-${s.id}`} size="small" variant="primary" label={s.yes_label ?? t('common.yes')} onPress={() => void sayYes(s)} />
        ) : null}
        <Button testID={`suggestion-no-${s.id}`} size="small" variant="text" label={s.no_label ?? t('common.not_now')} onPress={() => void sayNo(s)} />
      </View>
    </Inset>
  );
}
