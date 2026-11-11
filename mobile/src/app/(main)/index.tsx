import { router, useFocusEffect } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { ActionOut, SuggestionOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { PendingAnswerCard } from '@/components/PendingAnswerCard';
import { AlarmRiskBanner } from '@/components/ReminderCards';
import { MissedList, ReminderRows, useMinuteClock, useMissed } from '@/components/ReminderLists';
import { Screen } from '@/components/Screen';
import { TaskRow } from '@/components/TaskRow';
import { NextCard, PageTiles, TodayHeader, type NextItem } from '@/components/TodaySheet';
import { selectSortedPages, usePages } from '@/store/pages';
import { todayTiles } from '@/today/tiles';
import { useExpenses } from '@/expenses/store';
import { act } from '@/alarms/service';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { undoServerAction } from '@/tasks/actions';
import { localDate } from '@/tasks/rows';
import { doneAt, isDone, liveTasks, pageForList, setDone } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { canSayYes, refreshToday, sayNo, sayYes, useToday, visibleSuggestions } from '@/today/service';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';
import { useShallow } from 'zustand/react/shallow';
import { upcoming } from '@/alarms/plan';
import { useAlarms } from '@/alarms/store';

const DAY = 86_400_000;
const DEFAULT_SECTIONS = ['banner', 'missed', 'today', 'tiles', 'done_for_you', 'proposals', 'tip'];
/** The server may name the tiles section either way (today.md week 16). */
const SECTION_ALIAS: Record<string, string> = { page_tiles: 'tiles' };

/**
 * S06 «Сегодня» — system page, always first, cannot be removed (R-49); «за 3 с понять, что важно».
 * Week 9 (docs/api/today.md): missed reminders as red rows [Сделано] [Перенести], today's alarms
 * and to-dos with boxes, «Покупки: хлеб, молоко (3)», «Я сделал за вас» with «Отменить» and
 * «Что я сделал ›» (S20), ≤2 proposals and ≤1 tip with [Да] / [Не сейчас].
 * Built from what the phone holds, so it works offline and in «Без ИИ»; `GET /today` (when the tab
 * is shown) adds suggestions, the order of the sections and the greeting.
 * Week 16 — the tear-off sheet (template-screens 2.7): the day's number large, «Дальше» as the
 * first card (the nearest ring or to-do, [Сделано] [Отложить на 10 минут]), ≤2 tiles of other
 * pages (`page_tiles`, by the server's rule; offline the phone counts «Покупки» and «Расходы»),
 * «Сегодня свободно…» when there is nothing. «Без ИИ»: no proposals.
 */
export default function TodayScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const name = useOnboarding((s) => s.displayName);
  const noAi = useOnboarding(selectNoAi);
  const startedAt = useOnboarding((s) => s.openedAt ?? s.doneAt);
  const pages = usePages(useShallow(selectSortedPages));
  const expenseEntries = useExpenses((s) => s.entries);
  const now = useMinuteClock();
  const missed = useMissed(now);
  const last = useToday((s) => s.last);
  const answered = useToday((s) => s.answered);
  const tasks = useTasks((s) => s.tasks);
  const ticks = useTasks((s) => s.ticks);
  const actions = useTasks((s) => s.actions);
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
  const eod = dayStart + DAY;
  const rings = upcoming({ ...alarmSrc, now }, eod - now);
  const hasReminders = rings.length > 0;

  // «Дальше»: the nearest ring today, else the first open to-do of today.
  const firstRing = rings[0];
  const firstTodo = todos.find((x) => !isDone(x, ticks));
  const next: NextItem | null = firstRing
    ? { kind: 'reminder', key: firstRing.group, title: firstRing.title, at: firstRing.fireAt, alarm: firstRing.level === 'alarm' }
    : firstTodo
      ? { kind: 'task', key: firstTodo.id, title: firstTodo.title, at: null }
      : null;
  const listTodos = next?.kind === 'task' ? todos.filter((x) => x.id !== next.key) : todos;

  const tiles = todayTiles({
    pages,
    startedAt,
    now,
    today,
    server: last ? last.page_tiles : null,
    toBuy,
    expenses: Object.values(expenseEntries),
    t,
  });

  // «Я сделал за вас»: the assistant's own actions of the last 24 h, not undone, newest 3.
  const mine = Object.values(actions)
    .filter((a) => a.initiated_by === 'agent' && !a.undone_at && !a.undo_of && a.created_at && Date.parse(a.created_at) > now - DAY)
    .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''));
  const shown = visibleSuggestions(last, answered);
  const proposals = noAi ? [] : shown.proposals;
  const tip = noAi ? null : shown.tip;

  const greeting = name ? t('today.hello_name', { name }) : t('today.hello');
  const order = (last?.sections.length ? last.sections : DEFAULT_SECTIONS)
    .map((x) => SECTION_ALIAS[x] ?? x)
    .filter((x) => DEFAULT_SECTIONS.includes(x));
  for (const x of DEFAULT_SECTIONS) if (!order.includes(x)) order.push(x);

  const sections: Record<string, ReactNode> = {
    banner: <PendingAnswerCard key="banner" />,
    missed:
      missed.length > 0 ? (
        <View key="missed">
          <AppText variant="section" accessibilityRole="header" color="alarm" style={{ marginBottom: theme.space[3] }}>
            {t('missed.section')}
          </AppText>
          <MissedList rows={missed} now={now} />
        </View>
      ) : null,
    today: (
      <View key="today" style={{ marginBottom: theme.space[6] }}>
        <AppText variant="section" accessibilityRole="header" style={{ marginBottom: theme.space[3] }}>
          {t('today.today')}
        </AppText>
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.line,
            borderWidth: 1,
            borderRadius: theme.radius.card,
            paddingHorizontal: theme.space[4],
            paddingVertical: theme.space[2],
          }}
        >
          <ReminderRows segment="today" now={now} testPrefix="upcoming" skip={next?.kind === 'reminder' ? next.key : null} />
          {listTodos.map((x) => (
            <TaskRow key={x.id} task={x} done={isDone(x, ticks)} onToggle={() => void setDone(x.id, !isDone(x, ticks))} />
          ))}
          {toBuy.length > 0 ? (
            <Pressable
              testID="today-shopping"
              accessibilityRole="button"
              accessibilityHint={shopPage ? t('today.shopping_hint') : undefined}
              onPress={shopPage ? () => router.navigate({ pathname: '/page/[id]', params: { id: shopPage.id } }) : undefined}
              style={[styles.row, { minHeight: theme.size.primaryTouch, gap: theme.space[2] }]}
            >
              <AppText style={styles.flex}>
                {t('today.shopping', { titles: toBuy.slice(0, 5).map((x) => x.title).join(', '), n: toBuy.length })}
              </AppText>
              {shopPage ? <ChevronRight size={22} color={theme.colors.ink2} /> : null}
            </Pressable>
          ) : null}
          {!hasReminders && todos.length === 0 && toBuy.length === 0 ? (
            <AppText testID="today-empty" style={{ paddingVertical: theme.space[2] }}>
              {last?.empty && last.example ? t('today.free_example', { example: last.example }) : t('today.free')}
            </AppText>
          ) : next && rings.length - (next.kind === 'reminder' ? 1 : 0) === 0 && listTodos.length === 0 && toBuy.length === 0 ? (
            <AppText testID="today-rest-empty" variant="meta" style={{ paddingVertical: theme.space[2] }}>
              {t('today.nothing_else')}
            </AppText>
          ) : null}
        </View>
        <Button
          testID="today-new-reminder"
          label={t('today.new_reminder')}
          variant="outline"
          style={{ marginTop: theme.space[3] }}
          onPress={() => router.push('/reminder-new')}
        />
      </View>
    ),
    tiles: <PageTiles key="tiles" tiles={tiles} />,
    done_for_you: <DoneForYou key="done_for_you" list={mine.slice(0, 3)} />,
    proposals:
      proposals.length > 0 ? (
        <View key="proposals" style={{ marginBottom: theme.space[6], gap: theme.space[3] }}>
          <AppText variant="section" accessibilityRole="header">
            {t('today.suggest')}
          </AppText>
          {proposals.map((s) => (
            <SuggestionCard key={s.id} s={s} />
          ))}
        </View>
      ) : null,
    tip: tip ? (
      <View key="tip" style={{ marginBottom: theme.space[6] }}>
        <SuggestionCard s={tip} />
      </View>
    ) : null,
  };

  return (
    <Screen testID="page-today" edges={['top']}>
      <AlarmRiskBanner />
      <TodayHeader now={now} greeting={greeting} />
      {next ? (
        <NextCard
          next={next}
          now={now}
          onDone={() => (next.kind === 'reminder' ? void act(next.key, 'done') : void setDone(next.key, true))}
          onSnooze={next.kind === 'reminder' ? () => void act(next.key, 'snooze', 10) : undefined}
        />
      ) : null}
      {order.map((k) => sections[k] ?? null)}
    </Screen>
  );
}

/** «Я сделал за вас»: what the assistant did by itself today, each with «Отменить»; then S20. */
function DoneForYou({ list }: { list: ActionOut[] }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const showToast = useToast((s) => s.show);
  return (
    <View style={{ marginBottom: theme.space[6] }}>
      {list.length > 0 ? (
        <>
          <AppText variant="section" accessibilityRole="header" style={{ marginBottom: theme.space[3] }}>
            {t('today.did')}
          </AppText>
          {list.map((a) => {
            const text = (i18n.language === 'kk' && a.summary.kk) || a.summary.ru;
            return (
              <View
                key={a.id}
                testID={`did-today-${a.id}`}
                style={[styles.row, { gap: theme.space[2], borderBottomColor: theme.colors.line, borderBottomWidth: 1, minHeight: theme.size.primaryTouch }]}
              >
                <AppText style={styles.flex}>{text}</AppText>
                {a.undoable ? (
                  <Button
                    testID={`did-today-undo-${a.id}`}
                    label={t('common.undo')}
                    accessibilityLabel={t('did.undo_a11y', { what: text })}
                    variant="text"
                    minHeight={theme.size.minTouch}
                    onPress={() =>
                      void undoServerAction(a.id).then((r) => {
                        if (r.result === 'expired') showToast(t('changes.expired'), 4000);
                        else if (r.result === 'failed') showToast(t('errors.generic'), 4000);
                        else showToast(r.message ?? t('common.undone'), 3000);
                      })
                    }
                  />
                ) : null}
              </View>
            );
          })}
        </>
      ) : null}
      <Pressable
        testID="today-did-all"
        accessibilityRole="button"
        onPress={() => router.push('/did')}
        style={[styles.row, { minHeight: theme.size.primaryTouch, gap: theme.space[2] }]}
      >
        <AppText color="accent" style={styles.flex}>
          {t('more.did')}
        </AppText>
        <ChevronRight size={22} color={theme.colors.accent} />
      </Pressable>
    </View>
  );
}

/** A proposal or a tip: the text, [Да …] and [Не сейчас]. «Да» is never pre-focused or automatic. */
function SuggestionCard({ s }: { s: SuggestionOut }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const yes = canSayYes(s);
  return (
    <View
      testID={`suggestion-${s.id}`}
      style={{
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: theme.radius.card,
        backgroundColor: theme.colors.surface,
        padding: theme.space[4],
        gap: theme.space[3],
      }}
    >
      <AppText>{s.text_ru}</AppText>
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[2] }}>
        {yes ? (
          <Button
            testID={`suggestion-yes-${s.id}`}
            label={s.yes_label ?? t('common.yes')}
            style={theme.largeFont ? undefined : { flex: 1 }}
            onPress={() => void sayYes(s)}
          />
        ) : null}
        <Button
          testID={`suggestion-no-${s.id}`}
          label={s.no_label ?? t('common.not_now')}
          variant="outline"
          style={theme.largeFont ? undefined : { flex: 1 }}
          onPress={() => void sayNo(s)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
