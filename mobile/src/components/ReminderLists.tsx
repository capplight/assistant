import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { dayOffset, dayText, timeText } from '@/alarms/format';
import { lateRisk, upcoming } from '@/alarms/plan';
import {
  ackLate,
  deleteReminder,
  missedRows,
  refresh,
  takeBackDelete,
  takeBackLateDone,
  unackLocal,
  type MissedRow,
} from '@/alarms/service';
import { getSyncEngine } from '@/services';
import { undoServerAction } from '@/tasks/actions';
import { useAlarms } from '@/alarms/store';
import type { Segment } from '@/tasks/rows';
import { useTasks } from '@/tasks/store';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';

/** The clock for lists that change with time (a reminder passes, a row becomes «Пропущено»). */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function useMissed(now: number): MissedRow[] {
  const src = useAlarms(useShallow((s) => ({ fires: s.fires, reminders: s.reminders, local: s.local })));
  const handled = useTasks((s) => s.handledMissed);
  return missedRows(src, handled, now);
}

/**
 * «Пропущено 10:00 · Позвонить Ерлану» [Сделано] [Перенести] (2-design S06): red, a row per
 * missed occurrence. [Сделано] = a late `acked` (offline too); [Перенести] = S13 with the text.
 */
export function MissedList({ rows, now }: { rows: MissedRow[]; now: number }) {
  const theme = useTheme();
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  const done = async (row: MissedRow) => {
    const late = await ackLate(row.key);
    if (!late) return;
    useUndo.getState().showCustom(t('missed.done_strip', { title: row.title }), () => {
      void (async () => {
        const back = await takeBackLateDone(row.key, late, await getSyncEngine());
        if (back.local) return; // never went
        // Sent: the events answer named the action of this very event (`event_client_id`).
        const actionId =
          back.actionId ??
          Object.values(useTasks.getState().actions).find((x) => x.event_client_id === late.eventClientId)?.id ??
          null;
        const a = actionId ? useTasks.getState().actions[actionId] : undefined;
        if (!actionId || (a && (!a.undoable || a.undone_at))) {
          useToast.getState().show(t('missed.undo_gone'), 4000);
          return;
        }
        const r = await undoServerAction(actionId);
        if (r.result === 'done' || r.result === 'partial' || r.result === 'queued') unackLocal(row.key);
        else useToast.getState().show(t('changes.expired'), 4000);
      })();
    });
  };
  return (
    <View style={{ gap: theme.space[2], marginBottom: theme.space[4] }}>
      {rows.map((row) => {
        const when = dayOffset(row.at, now) === 0 ? timeText(row.at) : `${dayText(row.at, now)}, ${timeText(row.at)}`;
        const line = t('missed.row', { time: when, title: row.title });
        return (
          <View
            key={row.key}
            testID={`missed-${row.key}`}
            accessibilityLabel={line}
            style={{
              borderWidth: 2,
              borderColor: theme.colors.danger,
              borderRadius: theme.radius.lg,
              padding: theme.space[3],
              gap: theme.space[2],
            }}
          >
            <AppText color="danger" variant="bodyStrong">
              {line}
            </AppText>
            <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[2] }}>
              <Button
                testID={`missed-done-${row.key}`}
                label={t('missed.done')}
                accessibilityLabel={t('missed.done_a11y', { title: row.title })}
                style={theme.largeFont ? undefined : { flex: 1 }}
                onPress={() => void done(row)}
              />
              <Button
                testID={`missed-move-${row.key}`}
                label={t('missed.move')}
                accessibilityLabel={t('missed.move_a11y', { title: row.title })}
                variant="secondary"
                style={theme.largeFont ? undefined : { flex: 1 }}
                onPress={() =>
                  router.push({
                    pathname: '/reminder-new',
                    params: { text: row.title, missedKey: row.key, editId: row.reminderId },
                  })
                }
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

export async function removeReminder(
  id: string,
  title: string,
  t: (k: string, o?: Record<string, unknown>) => string,
): Promise<void> {
  const rowId = await deleteReminder(id);
  if (!rowId) return;
  useUndo.getState().showCustom(t('rem.deleted', { title }), () => {
    void (async () => {
      const back = await takeBackDelete(id, rowId);
      if (back.local) return;
      if (!back.actionId) {
        useToast.getState().show(t('missed.undo_gone'), 4000);
        return;
      }
      const r = await undoServerAction(back.actionId);
      if (r.result === 'expired' || r.result === 'failed') useToast.getState().show(t('changes.expired'), 4000);
      void refresh(); // its new fires
    })();
  });
}

function endOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Reminders of a segment: «Сегодня» to midnight, «Скоро» the next 14 days. Rings are local. */
export function ReminderRows({
  segment,
  now,
  testPrefix = 'rem',
  canDelete = false,
  skip,
}: {
  /** Week 16: the ring already shown in «Дальше» on «Сегодня». */
  skip?: string | null;
  segment: Exclude<Segment, 'missed'>;
  now: number;
  testPrefix?: string;
  /** «Дела»: «Удалить» with «Отменить» (DELETE /reminders/{id} is an action since week 9). */
  canDelete?: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const src = useAlarms(
    useShallow((s) => ({ reminders: s.reminders, fires: s.fires, local: s.local, deviceId: s.deviceId })),
  );
  const late = useAlarms((s) => lateRisk(s.caps));
  const all = upcoming({ ...src, now }, 14 * 24 * 60 * 60_000);
  const eod = endOfDay(now);
  const list = all.filter((a) => a.group !== skip && (segment === 'today' ? a.fireAt <= eod : a.fireAt > eod));
  if (list.length === 0) return null;
  return (
    <View style={{ marginBottom: theme.space[3] }}>
      {list.map((a) => {
        const level = a.level === 'alarm' ? t('alarm.level_alarm') : t('alarm.level_notification');
        const time = segment === 'today' ? timeText(a.fireAt) : `${dayText(a.fireAt, now)}, ${timeText(a.fireAt)}`;
        const reminderId = src.fires[a.group]?.reminder_id ?? null;
        return (
          <View key={a.group} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
            <Pressable
              testID={`${testPrefix}-${a.group}`}
              accessibilityLabel={`${level}. ${time}. ${a.title}`}
              style={{
                flex: 1,
                minHeight: theme.size.buttonHeight,
                justifyContent: 'center',
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.separator,
                paddingVertical: theme.space[2],
              }}
            >
              <AppText
                color={a.level === 'alarm' ? 'danger' : 'ink'}
              >{`${a.level === 'alarm' ? '🔔 ' : ''}${time} ${a.title}`}</AppText>
              <AppText variant="callout">{level}</AppText>
              {late ? (
                <AppText variant="callout" color="warning">
                  {t('rem.late_risk')}
                </AppText>
              ) : null}
            </Pressable>
            {canDelete && reminderId && !reminderId.startsWith('local:') ? (
              <Button
                testID={`${testPrefix}-delete-${a.group}`}
                label={t('rem.delete')}
                accessibilityLabel={t('rem.delete_a11y', { title: a.title })}
                variant="text"
                labelColor="danger"
                minHeight={theme.size.minTouch}
                onPress={() => void removeReminder(reminderId, a.title, t)}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** Сегодня · Скоро · Пропущено: three big buttons, the chosen one marked (not only by colour). */
export function Segments({
  value,
  onChange,
  missedCount,
}: {
  value: Segment;
  onChange: (s: Segment) => void;
  missedCount: number;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const items: { key: Segment; label: string }[] = [
    { key: 'today', label: t('tasks.seg_today') },
    { key: 'soon', label: t('tasks.seg_soon') },
    { key: 'missed', label: missedCount > 0 ? t('tasks.seg_missed_n', { n: missedCount }) : t('tasks.seg_missed') },
  ];
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[2] }}
    >
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            testID={`seg-${it.key}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(it.key)}
            style={{
              flex: theme.largeFont ? undefined : 1,
              minHeight: theme.size.minTouch,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: theme.radius.md,
              borderWidth: on ? 3 : 1,
              borderColor: on ? theme.colors.brand : theme.colors.iconSecondary,
              backgroundColor: on ? theme.colors.surface : 'transparent',
              paddingHorizontal: theme.space[2],
            }}
          >
            <AppText
              variant={on ? 'bodyStrong' : 'body'}
              color={it.key === 'missed' && missedCount > 0 ? 'danger' : 'ink'}
            >
              {it.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
