import { router } from 'expo-router';
import { Bell, Check, Ellipsis } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import { dayOffset, dayText } from '@/alarms/format';
import { lateRisk } from '@/alarms/plan';
import { moveReminder } from '@/alarms/service';
import { useAlarms } from '@/alarms/store';
import type { TaskOut } from '@/api/types';
import type { LocalRecord } from '@/db';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { changeTask, shownTask } from '@/tasks/edit';
import '@/tasks/actions'; // the undo of a tick (registers `tickUndo`)
import { listRows, localDate, type ListRow, type Segment } from '@/tasks/rows';
import { doneAt, isDone, listsForPage, setDone } from '@/tasks/service';
import { nowIndex, sheetSlots, timedItemIds, type Slot } from '@/tasks/sheet';
import { useTasks } from '@/tasks/store';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../Button';
import type { MenuExtra } from '../RecordMenuSheet';
import { MissedList, removeReminder, Segments, useMinuteClock, useMissed } from '../ReminderLists';
import { TaskRow } from '../TaskRow';
import { EntryList, type EntryCtx } from './EntryList';
import { dueText, fromList, type EntryRow, type Row } from './rows';
import type { ViewProps } from './registry';

const DAY = 86_400_000;

/** «08:00» — the time always in digits, never «утром» (template-screens 5). */
export const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** «Вторник, 10 ноября». */
function longDay(ms: number, lang: string): string {
  try {
    const s = new Date(ms).toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  } catch {
    return new Date(ms).toDateString();
  }
}

/**
 * «Дела и напоминания» — the day planner (template-screens 2.3; week 11а, replaces the week 9
 * list). Сегодня · Скоро · Пропущено as before; «Сегодня» is a sheet of the day: reminders at their
 * hours (🔔 + the word), a «Сейчас 11:20» line, missed ones in red where they were, then «Без
 * времени» — the to-dos in the person's own order, overdue in red with words — and «Сделано (N)»
 * grey with «Вернуть». A tap on a reminder opens S13; its «⋯» has «Перенести время» (+15 мин /
 * +1 час / Завтра / Выбрать) and «Удалить». Rows with a time are ordered by the time (they have no
 * «Выше / Ниже»); rows without one move freely. Ticks: at once, offline too, «Отменить» (week 9).
 * ≥150%: the time goes above the row as «10:00 · Будильник», the line is the words «Сейчас 11:20».
 */
export function PlannerView({ page, entries, frameTop, ordering }: ViewProps) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const hasShoppingPage = usePages((st) => st.pages.some((p) => p.templateKey === 'shopping'));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the lists follow «Покупки» existing
  const lists = useMemo(() => listsForPage(page), [page.templateKey, hasShoppingPage]);
  const tasksMap = useTasks((st) => st.tasks);
  const ticks = useTasks((st) => st.ticks);
  const edits = useTasks((st) => st.edits);
  const [segment, setSegment] = useState<Segment>('today');
  const [slotMenu, setSlotMenu] = useState<Slot | null>(null);
  const now = useMinuteClock();
  const missed = useMissed(now);
  const today = localDate(now);
  const src = useAlarms(useShallow((s) => ({ reminders: s.reminders, fires: s.fires, local: s.local, deviceId: s.deviceId })));
  const late = useAlarms((s) => lateRisk(s.caps));

  const sod = startOfDay(now);
  const missedKeys = useMemo(() => new Set(missed.map((m) => m.key)), [missed]);
  // today.md «Ежедневник»: occurrences of the day at their hours (main fire, by `occurrence_at`).
  const todaySlots = useMemo(() => sheetSlots(src, missedKeys, sod, sod + DAY), [src, missedKeys, sod]);
  const soonSlots = useMemo(() => sheetSlots(src, missedKeys, sod + DAY, sod + 15 * DAY).filter((s) => !s.acked), [src, missedKeys, sod]);
  const hours = todaySlots.filter((s) => !s.acked);
  const ackedToday = todaySlots.filter((s) => s.acked);
  const nowAt = nowIndex(hours, now);
  const timed = useMemo(() => timedItemIds(src.reminders), [src.reminders]);

  const tasks = useMemo(() => Object.values(tasksMap).map((x) => shownTask(x, edits)), [tasksMap, edits]);
  const taskByItem = useMemo(() => new Map(tasks.filter((x) => x.item_id).map((x) => [x.item_id!, x])), [tasks]);

  const { rows, overdue } = useMemo(() => {
    // A row whose record has a live reminder is drawn in its hour, not here (today.md).
    const notTimed = (r: ListRow) => !(r.kind === 'entry' && r.entry.record.serverId && timed.has(r.entry.record.serverId));
    const isOverdue = (r: ListRow) => !!r.task?.due_date && r.task.due_date < today;
    const base = listRows(entries ?? [], tasks, ticks, { lists: lists, segment: 'today', today });
    const late = base.open
      .filter((r) => notTimed(r) && isOverdue(r))
      .sort((a, b) => (a.task!.due_date! < b.task!.due_date! ? -1 : a.task!.due_date! > b.task!.due_date! ? 1 : 0));
    const out: Row[] = [];
    if (segment === 'missed') return { rows: late.map(fromList), overdue: late.length };
    if (segment === 'soon') {
      // «Скоро»: the same sheet by days; dates with nothing are left out.
      const soon = listRows(entries ?? [], tasks, ticks, { lists: lists, segment: 'soon', today });
      let last: string | null = null;
      for (const r of soon.open.filter(notTimed)) {
        const due = r.task?.due_date ?? null;
        if (due && due !== last) out.push({ type: 'group', key: `day:${due}`, title: due });
        last = due;
        out.push(fromList(r));
      }
      return { rows: out, overdue: late.length };
    }
    const open = base.open.filter((r) => notTimed(r) && !isOverdue(r));
    // «Сделано (N)»: to-dos done today and occurrences acked today.
    const done = base.done.filter((r) => !!r.task && localDate(doneAt(r.task, ticks)) === today);
    if (open.length > 0) out.push({ type: 'group', key: 'untimed', title: '' });
    out.push(...open.map(fromList));
    const n = done.length + ackedToday.length;
    if (n > 0) {
      out.push({ type: 'group', key: 'done', title: String(n) });
      out.push(...done.map(fromList));
    }
    return { rows: out, overdue: late.length };
  }, [entries, tasks, ticks, lists, segment, today, timed, ackedToday.length]);

  const groupTitle = (g: Extract<Row, { type: 'group' }>) => {
    if (g.key === 'untimed') return t('planner.untimed');
    if (g.key === 'done') return t('planner.done_n', { n: Number(g.title) || 0 });
    if (g.key.startsWith('day:')) {
      const ms = Date.parse(`${g.key.slice(4)}T12:00:00`);
      return Number.isFinite(ms) ? dayText(ms, now) : g.title;
    }
    return g.title;
  };

  const menuExtra = (record: LocalRecord): MenuExtra[] => {
    const task = record.serverId ? taskByItem.get(record.serverId) : undefined;
    if (!task || task.done) return [];
    const tomorrow = localDate(now + DAY);
    if (task.due_date === tomorrow) return [];
    return [
      {
        testID: 'menu-tomorrow',
        label: t('planner.to_tomorrow'),
        onPress: () => void changeTask(task.id, { due_date: tomorrow }, t('planner.moved_tomorrow', { title: task.title })),
      },
    ];
  };

  const renderEntry = (row: EntryRow, ctx: EntryCtx) => {
    const task = row.task;
    if (!task) return null;
    const overdue = !row.done && !!task.due_date && task.due_date < today;
    return (
      <View onLayout={ctx.onLayout}>
        <TaskRow
          task={task}
          done={row.done}
          showReturn
          box={40}
          meta={task.due_date && !row.done ? dueText(task.due_date, today, t) : null}
          metaColor={overdue ? 'alarm' : undefined}
          highlighted={ctx.highlighted}
          onToggle={() => void setDone(task.id, !row.done)}
          onMenu={ctx.moves?.onMenu}
        />
      </View>
    );
  };

  const header = (
    <View style={{ marginBottom: theme.space[3], gap: theme.space[3] }}>
      {frameTop}
      <Segments value={segment} onChange={setSegment} missedCount={missed.length + overdue} />
      {segment === 'missed' ? (
        missed.length + overdue > 0 ? (
          <MissedList rows={missed} now={now} />
        ) : (
          <AppText testID="missed-none">{t('tasks.missed_none')}</AppText>
        )
      ) : segment === 'today' ? (
        <View testID="planner-sheet" style={{ gap: theme.space[2] }}>
          <AppText testID="planner-day" variant="title2" accessibilityRole="header">
            {longDay(now, i18n.language)}
          </AppText>
          {hours.length === 0 && rows.length === 0 ? (
            <EmptyDay />
          ) : (
            <View>
              {hours.map((s, i) => (
                <View key={s.key}>
                  {i === nowAt ? <NowLine now={now} /> : null}
                  <SlotRow slot={s} late={late} task={s.itemId ? (taskByItem.get(s.itemId) ?? null) : null} onMenu={() => setSlotMenu(s)} onMissed={() => setSegment('missed')} />
                </View>
              ))}
              {hours.length > 0 && nowAt === hours.length ? <NowLine now={now} /> : null}
            </View>
          )}
        </View>
      ) : (
        <View testID="planner-soon" style={{ gap: theme.space[1] }}>
          {soonSlots.map((s, i) => {
            const first = i === 0 || dayOffset(soonSlots[i - 1]!.at, s.at) !== 0;
            return (
              <View key={s.key}>
                {first ? (
                  <AppText variant="section" accessibilityRole="header" style={{ paddingTop: theme.space[3], paddingBottom: theme.space[1] }}>
                    {dayText(s.at, now)}
                  </AppText>
                ) : null}
                <SlotRow slot={s} late={late} task={s.itemId ? (taskByItem.get(s.itemId) ?? null) : null} onMenu={() => setSlotMenu(s)} onMissed={() => setSegment('missed')} />
              </View>
            );
          })}
        </View>
      )}
    </View>
  );

  const footer =
    segment === 'missed' ? undefined : (
      <View style={{ marginTop: theme.space[4], gap: theme.space[2] }}>
        {segment === 'today'
          ? ackedToday.map((s) => <SlotRow key={s.key} slot={s} late={false} task={null} onMenu={() => undefined} onMissed={() => undefined} />)
          : null}
        <Button testID="tasks-new-reminder" label={t('today.new_reminder')} variant="outline" onPress={() => router.push('/reminder-new')} />
      </View>
    );

  return (
    <>
      <EntryList
        page={page}
        rows={rows}
        header={header}
        footer={footer}
        ordering={ordering}
        today={today}
        renderEntry={renderEntry}
        menuExtra={menuExtra}
        groupTitle={groupTitle}
      />
      {slotMenu ? <SlotMenu slot={slotMenu} onClose={() => setSlotMenu(null)} /> : null}
    </>
  );
}

/** «Сейчас 11:20»: words first, the accent line only adds to them. */
function NowLine({ now }: { now: number }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID="planner-now" accessibilityLiveRegion="none" style={[styles.row, { gap: theme.space[2], paddingVertical: theme.space[2] }]}>
      <AppText variant="bodyStrong" color="accent">
        {t('planner.now', { time: hhmm(now) })}
      </AppText>
      {theme.largeFont ? null : <View style={{ flex: 1, height: 3, backgroundColor: theme.colors.accent, borderRadius: 2 }} />}
    </View>
  );
}

function SlotRow({
  slot,
  late,
  task,
  onMenu,
  onMissed,
}: {
  slot: Slot;
  late: boolean;
  /** The page row with this time: its box is ticked here. */
  task: TaskOut | null;
  onMenu: () => void;
  onMissed: () => void;
}) {
  const ticks = useTasks((st) => st.ticks);
  const done = task ? isDone(task, ticks) : false;
  const theme = useTheme();
  const { t } = useTranslation();
  const level = slot.level === 'alarm' ? t('alarm.level_alarm') : t('alarm.level_notification');
  const time = hhmm(slot.at);
  const state = slot.acked || done ? t('planner.acked') : slot.missed ? t('planner.missed') : slot.snoozedUntil ? t('planner.snoozed', { time: hhmm(slot.snoozedUntil) }) : null;
  const label = [time, level, slot.title, state].filter(Boolean).join('. ');
  const open = () => {
    if (slot.missed) return onMissed();
    router.push({ pathname: '/reminder-new', params: { text: slot.title, ...(slot.reminderId ? { editId: slot.reminderId } : {}) } });
  };
  const grey = slot.acked || done;
  const color = grey ? 'ink2' : slot.missed ? 'alarm' : 'ink';
  return (
    <View
      style={[
        styles.row,
        {
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.line,
          ...(slot.missed ? { borderLeftWidth: 4, borderLeftColor: theme.colors.alarm, paddingLeft: theme.space[2] } : {}),
        },
      ]}
    >
      {task ? (
        <Pressable
          testID={`task-${task.id}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: done }}
          accessibilityLabel={`${time}. ${task.title}. ${done ? t('tasks.done') : t('tasks.not_done')}`}
          onPress={() => void setDone(task.id, !done)}
          style={{ width: theme.size.primaryTouch, height: theme.size.primaryTouch, alignItems: 'center', justifyContent: 'center' }}
        >
          <View style={{ width: 40, height: 40, borderWidth: 2, borderRadius: 6, borderColor: done ? theme.colors.ink2 : theme.colors.lineStrong, backgroundColor: done ? theme.colors.ink2 : theme.colors.surface, alignItems: 'center', justifyContent: 'center' }}>
            {done ? <Check size={28} color={theme.colors.surface} strokeWidth={3} /> : null}
          </View>
        </Pressable>
      ) : null}
      <Pressable
        testID={`rem-${slot.key}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={open}
        style={[styles.flex, { minHeight: theme.size.primaryTouch, paddingVertical: theme.space[2] }, theme.largeFont ? null : styles.row]}
      >
        {theme.largeFont ? (
          <AppText variant="bodyStrong" color={color}>
            {`${time} · ${level}`}
          </AppText>
        ) : (
          <AppText variant="number" color={color} style={{ width: 64 }}>
            {time}
          </AppText>
        )}
        <View style={[styles.flex, { gap: 2 }]}>
          <AppText color={color} variant={slot.missed ? 'bodyStrong' : 'body'} style={grey ? { textDecorationLine: 'line-through' } : undefined}>
            {slot.title}
          </AppText>
          {theme.largeFont ? null : (
            <View style={[styles.row, { gap: theme.space[1] }]}>
              {slot.level === 'alarm' ? <Bell size={16} color={theme.colors.ink2} /> : null}
              <AppText variant="meta">{level}</AppText>
            </View>
          )}
          {state ? (
            <AppText variant="meta" color={slot.missed && !grey ? 'alarm' : 'ink2'}>
              {state}
            </AppText>
          ) : null}
          {late && !slot.missed ? (
            <AppText variant="meta" color="warnText">
              {t('rem.late_risk')}
            </AppText>
          ) : null}
        </View>
      </Pressable>
      {slot.missed || slot.acked ? null : (
        <Pressable
          testID={`rem-menu-${slot.key}`}
          accessibilityRole="button"
          accessibilityLabel={t('planner.menu_a11y', { title: slot.title })}
          onPress={onMenu}
          style={{ width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ellipsis size={24} color={theme.colors.accent} />
        </Pressable>
      )}
    </View>
  );
}

/** «⋯» of a reminder: «Перенести время» (+15 мин / +1 час / Завтра / Выбрать), «Удалить». */
function SlotMenu({ slot, onClose }: { slot: Slot; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const reminder = useAlarms((s) => (slot.reminderId ? s.reminders[slot.reminderId] : undefined));
  const server = !!slot.reminderId && !slot.reminderId.startsWith('local:');
  const pick = () => {
    onClose();
    router.push({ pathname: '/reminder-new', params: { text: slot.title, ...(slot.reminderId ? { editId: slot.reminderId } : {}) } });
  };
  const shift = async (ms: number) => {
    onClose();
    if (!reminder || !slot.reminderId) return;
    const was = { title: reminder.title, dueAt: Date.parse(reminder.due_at), level: reminder.level, offsets: reminder.offsets };
    if (!Number.isFinite(was.dueAt)) return;
    const moved = await moveReminder(slot.reminderId, { ...was, dueAt: was.dueAt + ms });
    if (!moved) {
      // A repeating one moves as a whole series in S13; one made offline waits for its id.
      if (reminder.rrule) return pick();
      useToast.getState().show(t('planner.move_later'), 4000);
      return;
    }
    const id = slot.reminderId;
    useUndo.getState().showCustom(t('planner.moved', { title: reminder.title, time: hhmm(was.dueAt + ms) }), () => void moveReminder(id, was));
  };
  const row = (testID: string, label: string, onPress: () => void) => (
    <Button key={testID} testID={testID} label={label} variant="outline" onPress={onPress} />
  );
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID="slot-menu"
          style={{ backgroundColor: theme.colors.surface, borderTopLeftRadius: theme.radius.sheet, borderTopRightRadius: theme.radius.sheet, maxHeight: '90%' }}
        >
          <ScrollView contentContainerStyle={{ padding: theme.space[5], gap: theme.space[2] }}>
            <AppText variant="title2" accessibilityRole="header" numberOfLines={3}>
              {`${hhmm(slot.at)} ${slot.title}`}
            </AppText>
            <AppText variant="section" accessibilityRole="header">
              {t('planner.move_time')}
            </AppText>
            {row('slot-plus15', t('planner.plus15'), () => void shift(15 * 60_000))}
            {row('slot-plus60', t('planner.plus60'), () => void shift(60 * 60_000))}
            {row('slot-tomorrow', t('planner.tomorrow'), () => void shift(DAY))}
            {row('slot-pick', t('planner.pick'), pick)}
            {server ? (
              <Button
                testID={`rem-delete-${slot.key}`}
                label={t('rem.delete')}
                accessibilityLabel={t('rem.delete_a11y', { title: slot.title })}
                variant="text"
                labelColor="alarm"
                onPress={() => {
                  onClose();
                  void removeReminder(slot.reminderId!, slot.title, t);
                }}
              />
            ) : null}
            <Button testID="slot-close" label={t('common.close')} variant="text" onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/** Empty: a blank sheet with pale hours and what to say. */
function EmptyDay() {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID="planner-empty" style={{ gap: theme.space[2], paddingVertical: theme.space[2] }}>
      {['09:00', '12:00', '18:00'].map((h) => (
        <View key={h} importantForAccessibility="no-hide-descendants" style={[styles.row, { borderBottomWidth: 1, borderBottomColor: theme.colors.line, minHeight: 40, opacity: 0.5 }]}>
          <AppText variant="number" color="ink2">
            {h}
          </AppText>
        </View>
      ))}
      <AppText>{t('planner.empty')}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
