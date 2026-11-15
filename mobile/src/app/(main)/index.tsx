import { router, useFocusEffect } from 'expo-router';
import { CalendarDays, Copy, PhoneMissed, Search } from 'lucide-react-native';
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
import { Screen } from '@/components/Screen';
import { PageTiles, SectionLabel, ShoppingLine } from '@/components/TodaySheet';
import { BriefCard, MetricTile, TileGrid } from '@/components/ui/Brief';
import { Button } from '@/components/ui/Button';
import { Card, ListGroup, ListRow } from '@/components/ui/Card';
import { CheckCircle } from '@/components/ui/Check';
import { Header } from '@/components/ui/Header';
import { Timeline, type TimelineItem } from '@/components/ui/Timeline';
import { getRecords } from '@/db';
import { repeatsCount, visibleGroups } from '@/dedup/service';
import { useDedup } from '@/dedup/store';
import { addDays, formatMinor, periodOf } from '@/expenses/calc';
import { board, liveEntries } from '@/expenses/feed';
import { useExpenses } from '@/expenses/store';
import { ensureTemplatePage } from '@/pages/service';
import { LIST_LIMIT, useLocalQuery } from '@/records/useRecords';
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
import { metricColors, useTheme } from '@/theme';

const DAY = 86_400_000;
const MIN = 60_000;

/** «18 400 ₸» → «18 400» (the tile shows the sign as its unit). */
const bare = (money: string) => money.replace(/\s?₸$/, '');

/**
 * S06 «Сегодня» v2 — the morning briefing (design-system v2 §6, p14). Four blocks, always in this order:
 * 1. BriefCard: the status line, the headline of the day and a ≤3-line summary (a template from the numbers);
 * 2. 2×2 MetricTiles: Дела · Потрачено · Напоминания (Завтра in the evening) · Новое — each opens its section;
 * 3. «План дня»: a Timeline of today's rings (missed in red, the next one within the hour is the one sun card with
 *    «Готово» / «+10 мин»), then «Без времени» — today's to-dos with a circle;
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
  const records = useLocalQuery(async () => (await getRecords()).list(LIST_LIMIT), []);

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
  const todaySpends = todayRows.length;
  const todayMinor = board(todayRows, { from: today, to: today }, expenses.categories).main?.total ?? 0n;
  const leftMinor = budget !== null ? budget - spentMinor : null;
  const spentText = spentMinor > 0n ? formatMinor(spentMinor) : null;

  const newSince = part === 'morning' ? dayStart - DAY : dayStart;
  const newUntil = part === 'morning' ? dayStart : now + DAY;
  const fresh = (records ?? []).filter((r) => r.createdAt >= newSince && r.createdAt < newUntil).length;

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
  const firstOpen = todos.find((x) => !isDone(x, ticks));
  // Ф-49: «Купить: …» only while the shopping list is on (things to buy are to-dos in «Дела» otherwise).
  const shopping = useFeatures((f) => f.shopping);
  const toBuy = shopping ? liveTasks(tasks, 'shopping').filter((x) => !isDone(x, ticks)) : [];
  const shopPage = shopping ? pageForList('shopping') : undefined;
  const nextRing = rings[0];
  const tomorrowCount = tomorrowRings.length + tomorrowTodos.length;

  let dateLine: string;
  try {
    const d = new Date(now).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' });
    dateLine = `${d.charAt(0).toUpperCase()}${d.slice(1)} · ${timeText(now)}`;
  } catch {
    dateLine = timeText(now);
  }

  const risk = useAlarmRisk();
  const waiting = risk || missed.length > 0 || repeats > 0 || proposals.length > 0 || !!tip;

  return (
    <Screen testID="page-today" edges={['top']}>
      <View testID="today-header">
        <Header
          title={t('today.today')}
          meta={dateLine}
          actions={[
            { key: 'search', icon: Search, label: t('today.search'), onPress: () => router.navigate('/search'), testID: 'today-search' },
            { key: 'plan', icon: CalendarDays, label: t('today.open_tasks'), onPress: () => openPage('tasks'), testID: 'today-calendar' },
          ]}
        />
      </View>
      <View style={{ gap: theme.space[2] }}>
        <PendingAnswerCard />
        {/* «Подробнее» only when the summary is longer than its 3 lines (QA v2 §1.6). */}
        <BriefCard testID="today-brief" status={brief.status} headline={brief.headline} body={brief.body} more={brief.body.length > 140 ? t('today.more') : undefined} />

        <TileGrid testID="today-tiles-grid">
          <MetricTile
            testID="tile-tasks"
            label={t('today.tile_tasks')}
            value={String(done)}
            unit={total > 0 ? t('today.of_total', { total }) : t('today.tasks_unit', { count: 0 })}
            caption={
              total === 0
                ? t('today.nothing_planned')
                : part === 'evening'
                  ? firstOpen
                    ? t('today.left_one', { title: firstOpen.title })
                    : t('today.all_done')
                  : nextRing
                    ? t('today.next_at', { time: timeText(nextRing.fireAt) })
                    : undefined
            }
            color={metricColors[theme.scheme].tasks}
            progress={total > 0 ? done / total : null}
            onPress={() => openPage('tasks')}
          />
          <MetricTile
            testID="tile-spent"
            label={t('today.tile_spent')}
            // QA v2 §1.3: the sum and its line come from one period — the month against the budget, or today.
            value={bare(formatMinor(leftMinor !== null ? spentMinor : todayMinor))}
            unit="₸"
            caption={
              leftMinor !== null
                ? leftMinor >= 0n
                  ? t('today.budget_left', { sum: formatMinor(leftMinor) })
                  : t('today.budget_over', { sum: formatMinor(-leftMinor) })
                : todaySpends > 0
                  ? t('today.spent_today', { count: todaySpends })
                  : t('today.spent_none')
            }
            captionColor={leftMinor !== null && leftMinor < 0n ? 'danger' : 'ink2'}
            color={metricColors[theme.scheme].spent}
            progress={budget !== null && budget > 0n ? Number((spentMinor * 1000n) / budget) / 1000 : null}
            onPress={openExpenses}
          />
          {part === 'evening' ? (
            <MetricTile
              testID="tile-tomorrow"
              label={t('today.tile_tomorrow')}
              value={String(tomorrowCount)}
              unit={t('today.tasks_unit', { count: tomorrowCount })}
              caption={tomorrowRings[0] ? t('today.first_at', { time: timeText(tomorrowRings[0].fireAt) }) : undefined}
              color={metricColors[theme.scheme].reminders}
              onPress={() => openPage('tasks')}
            />
          ) : (
            <MetricTile
              testID="tile-reminders"
              label={t('today.tile_reminders')}
              value={String(rings.length)}
              caption={nextRing ? t('today.nearest_at', { time: timeText(nextRing.fireAt) }) : t('today.no_rings')}
              color={metricColors[theme.scheme].reminders}
              onPress={() => openPage('tasks')}
            />
          )}
          <MetricTile
            testID="tile-new"
            label={t('today.tile_new')}
            value={fresh > 0 ? `+${fresh}` : '0'}
            caption={fresh === 0 ? t('today.new_none') : part === 'morning' ? t('today.new_yesterday', { count: fresh }) : t('today.new_today', { count: fresh })}
            color={metricColors[theme.scheme].new}
            onPress={() => openPage('notes')}
          />
        </TileGrid>

        {toBuy.length > 0 ? (
          <ListGroup>
            <ShoppingLine
              titles={toBuy.map((x) => x.title)}
              hint={shopPage ? t('today.shopping_hint') : undefined}
              onPress={shopPage ? () => router.navigate({ pathname: '/page/[id]', params: { id: shopPage.id } }) : undefined}
            />
          </ListGroup>
        ) : null}
        {plan.length > 0 || todos.length > 0 ? (
          <View testID="today-list">
            {plan.length > 0 ? (
              <>
                <SectionLabel title={t('today.plan')} value={t('today.by_time', { count: plan.length })} />
                <Timeline testID="today-plan" items={plan} doneLabel={t('today.done_btn')} snoozeLabel={t('today.snooze_10')} />
              </>
            ) : null}
            {todos.length > 0 ? (
              <>
                <SectionLabel title={t('today.no_time')} value={done > 0 ? t('today.done_of', { done, total: todos.length }) : undefined} />
                <ListGroup>
                  {todos.map((x) => {
                    const overdue = !!x.due_date && x.due_date < today;
                    const checked = isDone(x, ticks);
                    return (
                      <ListRow
                        key={x.id}
                        testID={`task-${x.id}`}
                        title={x.title}
                        meta={overdue ? t('today.overdue') : undefined}
                        accessibilityRole="checkbox"
                        selected={checked}
                        left={<TodoCheck id={x.id} checked={checked} title={x.title} />}
                        onPress={() => void setDone(x.id, !checked)}
                      />
                    );
                  })}
                </ListGroup>
              </>
            ) : null}
          </View>
        ) : (
          <View testID="today-list-empty">
            <SectionLabel title={t('today.plan')} />
            <Card testID="today-empty">
              <AppText color="ink2">{last?.empty && last.example ? t('today.free_example', { example: last.example }) : t('today.plan_empty')}</AppText>
            </Card>
          </View>
        )}

        {waiting ? (
          <View testID="today-waiting">
            <SectionLabel title={t('today.waiting')} />
            <View style={{ gap: theme.space[2] }}>
              <AlarmRiskRow />
              {missed.length > 0 ? (
                <ListGroup>
                  {missed.slice(0, 2).map((row) => (
                    <ListRow
                      key={row.key}
                      testID={`waiting-missed-${row.key}`}
                      icon={PhoneMissed}
                      title={row.title}
                      meta={t('today.missed_meta')}
                      right={<Button testID={`missed-done-${row.key}`} label={t('today.done_btn')} variant="text" onPress={() => void markMissedDone(row, t)} />}
                    />
                  ))}
                </ListGroup>
              ) : null}
              {repeats > 0 ? (
                <ListGroup>
                  <ListRow
                    testID="waiting-repeats"
                    icon={Copy}
                    title={t('today.repeats', { count: repeats })}
                    meta={t('today.repeats_hint')}
                    chevron
                    onPress={() => router.push('/duplicates')}
                  />
                </ListGroup>
              ) : null}
              {proposals.map((s) => (
                <SuggestionCard key={s.id} s={s} />
              ))}
              {tip ? <SuggestionCard s={tip} /> : null}
            </View>
          </View>
        ) : null}
        <PageTiles tiles={tiles} />
      </View>
    </Screen>
  );
}

/** The 26 circle of a to-do «Без времени» (a tick works offline, with «Отменить»). */
function TodoCheck({ id, checked, title }: { id: string; checked: boolean; title: string }) {
  return <CheckCircle testID={`task-check-${id}`} checked={checked} label={title} onChange={(v) => void setDone(id, v)} />;
}

/** A proposal or a tip: the text, [Да …] and [Не сейчас]. «Да» is never pre-focused or automatic. */
function SuggestionCard({ s }: { s: SuggestionOut }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const yes = canSayYes(s);
  return (
    <Card testID={`suggestion-${s.id}`} style={{ gap: theme.space[3] }}>
      <AppText>{s.text_ru}</AppText>
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {yes ? (
          <Button testID={`suggestion-yes-${s.id}`} size="small" variant="secondary" label={s.yes_label ?? t('common.yes')} onPress={() => void sayYes(s)} />
        ) : null}
        <Button testID={`suggestion-no-${s.id}`} size="small" variant="text" label={s.no_label ?? t('common.not_now')} onPress={() => void sayNo(s)} />
      </View>
    </Card>
  );
}
