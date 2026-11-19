import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { dayText, timeText, wantsAlarm, whenWord } from '@/alarms/format';
import { lateRisk } from '@/alarms/plan';
import { dropPhrase, moveReminder, saveReminder } from '@/alarms/service';
import { useAlarms } from '@/alarms/store';
import type { ReminderDraft } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { CalendarSheet } from '@/components/ui/CalendarSheet';
import { Row, RowChevron, RowMeta } from '@/components/ui/Leaf';
import { ActionList, Sheet } from '@/components/ui/Sheet';
import { TimeWheel } from '@/components/ui/TimeWheel';
import { AlarmClock, Bell, CalendarDays, Check, Clock } from 'lucide-react-native';
import { Screen } from '@/components/Screen';
import { Header } from '@/components/ui/Header';
import { useToast } from '@/store/toast';
import { tasksState } from '@/tasks/store';
import { fontFamily, MAX_FONT_SCALE, useTheme } from '@/theme';

const MIN = 60_000;
const OFFSETS = [0, 15, 60, 1440] as const;

function parseJson<T>(v: string | undefined): T | null {
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

/** Next full hour, at least 30 min from now: a time the person only nudges. */
function defaultDue(now: number): number {
  const d = new Date(now + 30 * MIN);
  d.setMinutes(0, 0, 0);
  return d.getTime() + 60 * MIN;
}

/**
 * S13 «Напоминание» (2-design S13): «как понял» after `POST /reminders/parse`, or the manual form
 * («Поставить вручную», «+ → Напоминание»). Saving works without the internet and in «Без ИИ»:
 * it rings from this phone at once, the server gets it through the outbox. New → no «Да».
 * Week 9: «Перенести» on a missed row opens it with the text (`missedKey`): saved = the row goes.
 * Not here yet: repeats by days (RRULE), changing an existing reminder (S25).
 */
export default function ReminderScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const p = useLocalSearchParams<{
    text?: string;
    draft?: string;
    options?: string;
    message?: string;
    phraseId?: string;
    missedKey?: string;
    editId?: string;
    messageId?: string;
    via?: string;
  }>();
  const caps = useAlarms((s) => s.caps);
  const showToast = useToast((s) => s.show);
  const [now] = useState(() => Date.now());

  const options = useMemo(() => parseJson<ReminderDraft[]>(p.options) ?? [], [p.options]);
  const first = useMemo(() => parseJson<ReminderDraft>(p.draft) ?? options[0] ?? null, [p.draft, options]);
  const parsed = first !== null;

  const [title, setTitle] = useState(first?.title ?? p.text ?? '');
  const [due, setDue] = useState(() => (first?.due_at ? Date.parse(first.due_at) : defaultDue(now)));
  const editing = useAlarms((s) => (p.editId ? s.reminders[p.editId] : undefined));
  const [level, setLevel] = useState<'alarm' | 'notification'>(
    first?.level ?? editing?.level ?? (wantsAlarm(p.text ?? '') ? 'alarm' : 'notification'),
  );
  const [offset, setOffset] = useState<number>(first?.offsets[0] ?? 0);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // «в 7», «завтра в 10»: always asked — 7:00 or 19:00 — never a silent morning (founder, 2026-11-09).
  const mustChoose = options.length > 1;
  const [chose, setChose] = useState(false);

  const [calOpen, setCalOpen] = useState(false);
  const [offsetOpen, setOffsetOpen] = useState(false);
  // screens-v5-extra «Дело · редактор»: the time is a wheel (5 min steps), the day chips; «Другой день» — the calendar.
  const setTime = (h: number, m: number) => {
    const d = new Date(due);
    d.setHours(h, m, 0, 0);
    setDue(d.getTime());
    setEdited(true);
    setError(null);
  };
  const setDate = (dayStart: number) => {
    const d = new Date(due);
    const n = new Date(dayStart);
    d.setFullYear(n.getFullYear(), n.getMonth(), n.getDate());
    setDue(d.getTime());
    setEdited(true);
    setError(null);
  };
  const setDay = (days: number) => {
    const d = new Date(due);
    const today = new Date(now);
    d.setFullYear(today.getFullYear(), today.getMonth(), today.getDate() + days);
    setDue(d.getTime());
    setEdited(true);
    setError(null);
  };

  const save = async () => {
    const text = title.trim();
    if (!text) return setError(t('rem.need_title'));
    if (mustChoose && !chose && !edited) return setError(t('rem.choose_time'));
    if (due <= Date.now() + 30_000) return setError(t('rem.past'));
    const input = {
      title: text,
      dueAt: due,
      level,
      offsets: offset ? [offset] : [],
    };
    // «Перенести» a missed one: the same reminder moves (PATCH); a repeating one gets a new one-off.
    const moved = p.editId ? await moveReminder(p.editId, input) : null;
    if (!moved) {
      await saveReminder({
        ...input,
        createdVia: p.via === 'agent_suggestion' || p.via === 'voice' ? p.via : parsed ? 'typed' : 'manual_form',
        parseSource: !parsed || edited ? 'user_edit' : null,
        messageId: p.messageId ?? null,
      });
    }
    if (p.phraseId) dropPhrase(p.phraseId);
    // «Перенести» a missed one (week 9): the new time replaces the red row.
    if (p.missedKey) {
      const st = tasksState();
      st.set({ handledMissed: [...st.handledMissed, p.missedKey].slice(-200) });
    }
    showToast(t('rem.saved', { when: whenWord(due, Date.now()), time: timeText(due) }), 3000);
    // R-12 / 2-design 5.3: the first reminder asks for notifications (S04) if nobody asked yet.
    const s = useAlarms.getState();
    if (s.caps?.notifications !== 'granted' && !s.notifyAskedAt)
      router.replace({ pathname: '/notify', params: { saved: text } });
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const chip = (key: string, label: string, selected: boolean, onPress: () => void, icon?: typeof Bell) => (
    <Pressable
      key={key}
      testID={`rem-${key}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.chip,
        {
          // v5 chip: a 1.5 `line2` outline, the chosen one `btn` (screens-v5-extra «Дело · редактор»).
          minHeight: theme.size.minTouch,
          borderRadius: theme.radius.round,
          backgroundColor: selected ? theme.colors.btn : 'transparent',
          borderWidth: selected ? 0 : 1.5,
          borderColor: theme.colors.line2,
          paddingHorizontal: 15,
        },
      ]}
    >
      <View style={[styles.row, { gap: 6 }]}>
        {icon
          ? (() => {
              const I = icon;
              return <I size={18} color={selected ? theme.colors.onBtn : theme.colors.ink} strokeWidth={2} />;
            })()
          : null}
        <AppText
          color={selected ? 'onBtn' : 'ink'}
          style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15 }}
        >
          {label}
        </AppText>
      </View>
    </Pressable>
  );

  const offsetLabel = (o: number) =>
    o === 0 ? t('rem.at_moment') : o === 15 ? t('rem.before15') : o === 60 ? t('rem.before60') : t('rem.day_before');

  const off = Math.round((new Date(due).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);

  return (
    // screens-v5-extra «Дело · редактор»: the lilac strip of «Дела», the fields labelled above, the time = one big number.
    <Screen
      testID="reminder-screen"
      place="tasks"
      mode="strip"
      footer={<Button testID="rem-save" label={t('rem.save')} onPress={() => void save()} />}
    >
      <Header
        title={parsed ? t('rem.title_parsed') : t('rem.title_new')}
        back={{ onPress: () => router.back(), label: t('rem.close'), testID: 'rem-close' }}
      />
      {p.message ? (
        <AppText testID="rem-message" style={{ marginBottom: theme.space[3] }}>
          {p.message}
        </AppText>
      ) : null}
      <AppText variant="caption" style={styles.label}>
        {t('rem.what')}
      </AppText>
      <TextInput
        testID="rem-title"
        accessibilityLabel={t('rem.what')}
        placeholder={t('rem.what_placeholder')}
        placeholderTextColor={theme.colors.ink2}
        value={title}
        onChangeText={(v) => {
          setTitle(v);
          setError(null);
        }}
        multiline
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={[
          theme.type.body,
          {
            marginTop: theme.space[2],
            marginBottom: theme.space[5],
            minHeight: theme.size.buttonHeight,
            borderRadius: 16,
            borderWidth: 1.5,
            borderColor: theme.colors.ink,
            padding: theme.space[3],
            paddingHorizontal: theme.space[4],
            color: theme.colors.ink,
            backgroundColor: theme.colors.paper,
          },
        ]}
      />

      <AppText variant="caption" style={styles.label}>
        {t('rem.when')}
      </AppText>
      {options.length > 1 ? (
        <View style={[styles.wrap, { gap: theme.space[2], marginTop: theme.space[2] }]}>
          {options.map((o, i) =>
            chip(
              `option-${i}`,
              o.local?.time ?? (o.due_at ? timeText(Date.parse(o.due_at)) : ''),
              chose && !!o.due_at && Date.parse(o.due_at) === due,
              () => {
                if (o.due_at) setDue(Date.parse(o.due_at));
                setChose(true);
                setError(null);
              },
            ),
          )}
        </View>
      ) : null}
      <View style={[styles.wrap, { gap: theme.space[2], marginTop: theme.space[2] }]}>
        {chip('today', t('rem.today'), off === 0, () => setDay(0))}
        {chip('tomorrow', t('rem.tomorrow'), off === 1, () => setDay(1))}
        <Pressable
          testID="rem-other-day"
          accessibilityRole="button"
          accessibilityState={{ selected: off > 1 }}
          accessibilityLabel={off > 1 ? `${t('rem.other_day')}: ${dayText(due, now)}` : t('rem.other_day')}
          onPress={() => setCalOpen(true)}
          style={[
            styles.chip,
            styles.row,
            {
              gap: 6,
              minHeight: theme.size.minTouch,
              borderRadius: theme.radius.round,
              paddingHorizontal: 15,
              backgroundColor: off > 1 ? theme.colors.btn : 'transparent',
              borderWidth: off > 1 ? 0 : 1.5,
              borderColor: theme.colors.line2,
            },
          ]}
        >
          <CalendarDays size={18} color={off > 1 ? theme.colors.onBtn : theme.colors.ink} strokeWidth={2} />
          <AppText
            color={off > 1 ? 'onBtn' : 'ink'}
            style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15 }}
          >
            {off > 1 ? dayText(due, now).split(',').slice(0, 2).join(',') : t('rem.other_day')}
          </AppText>
        </Pressable>
      </View>
      {first?.time_assumed && !edited ? (
        // The assistant set the time itself: the terracotta mark «проверьте» (not a warning colour).
        <AppText variant="mark" color="assistantText" style={{ marginTop: theme.space[2] }}>
          {t('rem.time_assumed')}
        </AppText>
      ) : null}
      <View style={{ marginTop: 6 }} accessibilityLabel={t('rem.time_a11y', { time: timeText(due) })}>
        <TimeWheel
          testID="rem-wheel"
          hour={new Date(due).getHours()}
          minute={new Date(due).getMinutes()}
          onChange={setTime}
        />
      </View>
      <AppText
        testID="rem-time"
        style={styles.hidden}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {timeText(due)}
      </AppText>

      <AppText variant="caption" style={[styles.label, { marginTop: theme.space[3] }]}>
        {t('rem.how')}
      </AppText>
      <View style={[styles.wrap, { gap: theme.space[2], marginTop: theme.space[2] }]}>
        {chip(
          'level-notification',
          t('alarm.level_notification'),
          level === 'notification',
          () => setLevel('notification'),
          Bell,
        )}
        {chip('level-alarm', t('alarm.level_alarm'), level === 'alarm', () => setLevel('alarm'), AlarmClock)}
      </View>
      {lateRisk(caps) ? (
        <AppText testID="rem-late-risk" variant="small" style={{ marginTop: theme.space[2] }}>
          {t('rem.late_risk')}
        </AppText>
      ) : null}

      <Row
        testID="rem-offset"
        onPress={() => setOffsetOpen(true)}
        accessibilityLabel={`${t('rem.remind_more')}: ${offsetLabel(offset)}`}
        style={{ marginTop: theme.space[2] }}
      >
        <Clock size={22} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
        <AppText numberOfLines={1} style={styles.flex}>
          {t('rem.remind_more')}
        </AppText>
        <RowMeta>{offsetLabel(offset)}</RowMeta>
        <RowChevron />
      </Row>
      {calOpen ? (
        <CalendarSheet
          value={due}
          now={now}
          onClose={() => setCalOpen(false)}
          onPick={(d) => {
            setDate(d);
            setCalOpen(false);
          }}
        />
      ) : null}
      {offsetOpen ? (
        <Sheet
          visible
          testID="rem-offset-sheet"
          title={t('rem.remind_more')}
          onClose={() => setOffsetOpen(false)}
          place="tasks"
        >
          <ActionList
            actions={OFFSETS.map((o) => ({
              key: `o-${o}`,
              testID: `rem-offset-${o}`,
              label: offsetLabel(o),
              icon: offset === o ? Check : undefined,
              onPress: () => {
                setOffset(o);
                setOffsetOpen(false);
              },
            }))}
          />
        </Sheet>
      ) : null}
      <AppText variant="callout" style={{ marginTop: theme.space[3] }}>
        {t('rem.no_repeat')}
      </AppText>
      {error ? (
        <AppText
          testID="rem-error"
          color="danger"
          accessibilityLiveRegion="polite"
          style={{ marginTop: theme.space[3] }}
        >
          {error}
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
  chip: { justifyContent: 'center' },
  label: { fontFamily: fontFamily.semibold, marginBottom: 2 },
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});
