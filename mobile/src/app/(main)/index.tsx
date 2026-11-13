import { router, useFocusEffect } from 'expo-router';
import { useCallback, type ReactNode } from 'react';
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
import { AlarmRiskBanner } from '@/components/ReminderCards';
import { useMinuteClock, useMissed } from '@/components/ReminderLists';
import { Screen } from '@/components/Screen';
import { DayCard, NextCard, PageTiles, SectionLabel, ShoppingLine, TodayHeader, TodayRow, type NextItem } from '@/components/TodaySheet';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useExpenses } from '@/expenses/store';
import { useFeatures } from '@/store/features';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { selectSortedPages, usePages } from '@/store/pages';
import { localDate } from '@/tasks/rows';
import { doneAt, isDone, liveTasks, pageForList, setDone } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { markMissedDone } from '@/today/missed';
import { canSayYes, refreshToday, sayNo, sayYes, useToday, visibleSuggestions } from '@/today/service';
import { todayTiles } from '@/today/tiles';
import { useTheme } from '@/theme';

const DAY = 86_400_000;

/**
 * S06 «Сегодня» (design-system §4 mock, ux-audit P0-3): three blocks only —
 * 1. «Дальше»: the nearest ring today, else the first open to-do (the one sun card, [Сделано] [Отложить]);
 * 2. «На сегодня»: one flat list — missed rings (time in red, the circle = a late «Сделано», the row = «Перенести»),
 *    today's rings and to-dos with a circle, «Купить: молоко и ещё 3» in one line;
 * 3. one tip in the first week (`today.tips_days` / `tips_per_day`, Ф-42).
 * Page tiles only with `today.tiles`, proposals only with `today.proposals` (both off for the beta). The alarm risk
 * is a narrow line, only once a ring exists. «Я сделал за вас» and «Новое напоминание» moved off the first screen
 * («Ещё → Что я сделал», the line and «+»). Built from what the phone holds (offline, «Без ИИ»); `GET /today` adds
 * suggestions and its reminders / tasks.
 */
export default function TodayScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const noAi = useOnboarding(selectNoAi);
  const startedAt = useOnboarding((s) => s.openedAt ?? s.doneAt);
  const features = useFeatures((f) => f.today);
  const pages = usePages(useShallow(selectSortedPages));
  const expenseEntries = useExpenses((s) => s.entries);
  const now = useMinuteClock();
  const missed = useMissed(now);
  const last = useToday((s) => s.last);
  const answered = useToday((s) => s.answered);
  const tasks = useTasks((s) => s.tasks);
  const ticks = useTasks((s) => s.ticks);
  const alarmSrc = useAlarms(useShallow((s) => ({ reminders: s.reminders, fires: s.fires, local: s.local, deviceId: s.deviceId })));

  useFocusEffect(
    useCallback(() => {
      void refreshToday();
    }, []),
  );

  const today = localDate(now);
  const dayStart = new Date(`${today}T00:00:00`).getTime();

  // To-dos for today: not done with a day ≤ today (overdue first); ticked today stay, crossed out.
  const todos = liveTasks(tasks, 'todo')
    .filter((x) => !!x.due_date && x.due_date <= today)
    .filter((x) => !isDone(x, ticks) || doneAt(x, ticks) >= dayStart)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
    .slice(0, 20);
  const toBuy = liveTasks(tasks, 'shopping').filter((x) => !isDone(x, ticks));
  const shopPage = pageForList('shopping');
  const rings = upcoming({ ...alarmSrc, now }, dayStart + DAY - now);

  // «Дальше»: the nearest ring today, else the first open to-do of today.
  const firstRing = rings[0];
  const firstTodo = todos.find((x) => !isDone(x, ticks));
  const next: NextItem | null = firstRing
    ? { kind: 'reminder', key: firstRing.group, title: firstRing.title, at: firstRing.fireAt, alarm: firstRing.level === 'alarm' }
    : firstTodo
      ? { kind: 'task', key: firstTodo.id, title: firstTodo.title, at: null }
      : null;
  const listRings = rings.filter((r) => !(next?.kind === 'reminder' && r.group === next.key));
  const listTodos = next?.kind === 'task' ? todos.filter((x) => x.id !== next.key) : todos;

  const tiles = features.tiles
    ? todayTiles({ pages, startedAt, now, today, server: last ? last.page_tiles : null, toBuy, expenses: Object.values(expenseEntries), t })
    : [];

  const shown = visibleSuggestions(last, answered);
  const proposals = noAi || !features.proposals ? [] : shown.proposals;
  const ageDays = startedAt ? (now - Date.parse(startedAt)) / DAY : 0;
  const tipAllowed = !noAi && features.tips_per_day > 0 && (features.tips_days === 0 || ageDays < features.tips_days);
  const tip = tipAllowed ? shown.tip : null;

  // The flat list of the day.
  const rows: { key: string; node: (separator: boolean) => ReactNode }[] = [];
  for (const row of missed) {
    const when = dayOffset(row.at, now) === 0 ? timeText(row.at) : `${dayText(row.at, now)}, ${timeText(row.at)}`;
    rows.push({
      key: `m-${row.key}`,
      node: (sep) => (
        <TodayRow
          key={`m-${row.key}`}
          testID={`missed-${row.key}`}
          checkTestID={`missed-done-${row.key}`}
          title={row.title}
          time={when}
          overdue
          done={false}
          label={t('missed.row', { time: when, title: row.title })}
          onToggle={() => void markMissedDone(row, t)}
          onPress={() => router.push({ pathname: '/reminder-new', params: { text: row.title, missedKey: row.key, editId: row.reminderId } })}
          separator={sep}
        />
      ),
    });
  }
  for (const r of listRings) {
    rows.push({
      key: `r-${r.group}`,
      node: (sep) => (
        <TodayRow
          key={`r-${r.group}`}
          testID={`upcoming-${r.group}`}
          checkTestID={`upcoming-done-${r.group}`}
          title={r.title}
          time={timeText(r.fireAt)}
          done={false}
          label={`${r.level === 'alarm' ? t('alarm.level_alarm') : t('alarm.level_notification')}. ${timeText(r.fireAt)}. ${r.title}`}
          onToggle={() => void act(r.group, 'done')}
          separator={sep}
        />
      ),
    });
  }
  for (const x of listTodos) {
    const overdue = !!x.due_date && x.due_date < today;
    rows.push({
      key: `t-${x.id}`,
      node: (sep) => (
        <TodayRow
          key={`t-${x.id}`}
          testID={`task-${x.id}`}
          checkTestID={`task-check-${x.id}`}
          title={x.title}
          time={overdue ? t('today.overdue') : undefined}
          overdue={overdue}
          done={isDone(x, ticks)}
          onToggle={() => void setDone(x.id, !isDone(x, ticks))}
          separator={sep}
        />
      ),
    });
  }
  const openTotal = missed.length + listRings.length + listTodos.length + (next ? 1 : 0);
  const doneCount = listTodos.filter((x) => isDone(x, ticks)).length;
  const nothing = !next && rows.length === 0 && toBuy.length === 0;

  return (
    <Screen testID="page-today" edges={['top']}>
      <TodayHeader now={now} />
      <PendingAnswerCard />
      <AlarmRiskBanner />
      {next ? (
        <NextCard
          next={next}
          now={now}
          onDone={() => (next.kind === 'reminder' ? void act(next.key, 'done') : void setDone(next.key, true))}
          onSnooze={next.kind === 'reminder' ? () => void act(next.key, 'snooze', 10) : undefined}
        />
      ) : null}
      {nothing ? (
        <Card testID="today-empty" style={{ marginTop: theme.space[2] }}>
          <AppText color="ink2">{last?.empty && last.example ? t('today.free_example', { example: last.example }) : t('today.free')}</AppText>
        </Card>
      ) : rows.length > 0 || toBuy.length > 0 ? (
        <View testID="today-list">
          <SectionLabel title={t('today.for_today')} value={doneCount > 0 ? t('today.done_of', { done: doneCount, total: openTotal }) : undefined} />
          <DayCard>
            {rows.map((r, i) => r.node(i < rows.length - 1 || toBuy.length > 0))}
            {toBuy.length > 0 ? (
              <ShoppingLine
                titles={toBuy.map((x) => x.title)}
                hint={shopPage ? t('today.shopping_hint') : undefined}
                onPress={shopPage ? () => router.navigate({ pathname: '/page/[id]', params: { id: shopPage.id } }) : undefined}
              />
            ) : null}
          </DayCard>
        </View>
      ) : (
        <AppText testID="today-rest-empty" variant="callout" style={{ marginTop: theme.space[3], paddingHorizontal: theme.space[1] }}>
          {t('today.nothing_else')}
        </AppText>
      )}
      <PageTiles tiles={tiles} />
      {proposals.length > 0 ? (
        <View testID="today-proposals">
          <SectionLabel title={t('today.suggest')} />
          <View style={{ gap: theme.space[2] }}>
            {proposals.map((s) => (
              <SuggestionCard key={s.id} s={s} />
            ))}
          </View>
        </View>
      ) : null}
      {tip ? (
        <View style={{ marginTop: theme.space[4] }}>
          <SuggestionCard s={tip} />
        </View>
      ) : null}
    </Screen>
  );
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
