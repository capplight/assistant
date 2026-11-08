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
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useToast } from '@/store/toast';
import { tasksState } from '@/tasks/store';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

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
  const p = useLocalSearchParams<{ text?: string; draft?: string; options?: string; message?: string; phraseId?: string; missedKey?: string; editId?: string; messageId?: string; via?: string }>();
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

  const move = (ms: number) => {
    setDue((d) => d + ms);
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
    if (s.caps?.notifications !== 'granted' && !s.notifyAskedAt) router.replace({ pathname: '/notify', params: { saved: text } });
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const chip = (key: string, label: string, selected: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      testID={`rem-${key}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.chip,
        {
          minHeight: theme.size.minTouch,
          borderRadius: theme.radius.button,
          borderColor: selected ? theme.colors.accent : theme.colors.lineStrong,
          backgroundColor: selected ? theme.colors.accent : theme.colors.surface,
          paddingHorizontal: theme.space[4],
        },
      ]}
    >
      <AppText color={selected ? 'onAccent' : 'ink'}>{label}</AppText>
    </Pressable>
  );

  const step = (key: string, label: string, sign: string, onPress: () => void) => (
    <Pressable
      testID={`rem-${key}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.step,
        { minWidth: theme.size.primaryTouch + 16, minHeight: theme.size.primaryTouch, paddingHorizontal: theme.space[2], borderRadius: theme.radius.button, borderColor: theme.colors.lineStrong },
      ]}
    >
      <AppText variant="title2">{sign}</AppText>
    </Pressable>
  );

  const off = Math.round((new Date(due).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);

  return (
    <Screen
      testID="reminder-screen"
      footer={<Button testID="rem-save" label={t('rem.save')} onPress={() => void save()} />}
    >
      <View style={[styles.row, { marginBottom: theme.space[4] }]}>
        <AppText variant="title1" accessibilityRole="header" style={styles.flex}>
          {parsed ? t('rem.title_parsed') : t('rem.title_new')}
        </AppText>
        <Button testID="rem-close" label={t('rem.close')} variant="text" minHeight={theme.size.minTouch} onPress={() => router.back()} />
      </View>
      {p.message ? (
        <AppText testID="rem-message" color="warnText" style={{ marginBottom: theme.space[3] }}>
          {p.message}
        </AppText>
      ) : null}
      <AppText variant="section">{t('rem.what')}</AppText>
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
            minHeight: theme.size.primaryTouch,
            borderWidth: 1,
            borderColor: theme.colors.lineStrong,
            borderRadius: theme.radius.input,
            padding: theme.space[3],
            color: theme.colors.ink,
            backgroundColor: theme.colors.surface,
          },
        ]}
      />

      <AppText variant="section">{t('rem.when')}</AppText>
      {options.length > 1 ? (
        <View style={[styles.wrap, { gap: theme.space[2], marginTop: theme.space[2] }]}>
          {options.map((o, i) =>
            chip(`option-${i}`, o.local?.time ?? (o.due_at ? timeText(Date.parse(o.due_at)) : ''), chose && !!o.due_at && Date.parse(o.due_at) === due, () => {
              if (o.due_at) setDue(Date.parse(o.due_at));
              setChose(true);
              setError(null);
            }),
          )}
        </View>
      ) : null}
      <AppText testID="rem-day" variant="title2" style={{ marginTop: theme.space[3] }}>
        {dayText(due, now)}
      </AppText>
      <AppText testID="rem-time" variant="display" accessibilityLabel={t('rem.time_a11y', { time: timeText(due) })}>
        {timeText(due)}
      </AppText>
      {first?.time_assumed && !edited ? (
        <AppText color="warnText" variant="meta">
          {t('rem.time_assumed')}
        </AppText>
      ) : null}
      <View style={[styles.row, { gap: theme.space[2], marginTop: theme.space[3] }]}>
        {step('hour-minus', t('rem.hour_minus'), '−1:00', () => move(-60 * MIN))}
        {step('hour-plus', t('rem.hour_plus'), '+1:00', () => move(60 * MIN))}
        {step('min-minus', t('rem.min_minus'), '−0:05', () => move(-5 * MIN))}
        {step('min-plus', t('rem.min_plus'), '+0:05', () => move(5 * MIN))}
      </View>
      <View style={[styles.wrap, { gap: theme.space[2], marginTop: theme.space[3], marginBottom: theme.space[5] }]}>
        {chip('today', t('rem.today'), off === 0, () => setDay(0))}
        {chip('tomorrow', t('rem.tomorrow'), off === 1, () => setDay(1))}
        {chip('day-next', t('rem.day_next'), false, () => setDay(off + 1))}
        {off > 0 ? chip('day-prev', t('rem.day_prev'), false, () => setDay(off - 1)) : null}
      </View>

      <AppText variant="section">{t('rem.how')}</AppText>
      <View style={[styles.wrap, { gap: theme.space[2], marginTop: theme.space[2] }]}>
        {chip('level-alarm', `🔔 ${t('alarm.level_alarm')}`, level === 'alarm', () => setLevel('alarm'))}
        {chip('level-notification', t('alarm.level_notification'), level === 'notification', () => setLevel('notification'))}
      </View>
      {lateRisk(caps) ? (
        <AppText testID="rem-late-risk" color="warnText" variant="meta" style={{ marginTop: theme.space[2] }}>
          {t('rem.late_risk')}
        </AppText>
      ) : null}

      <AppText variant="section" style={{ marginTop: theme.space[5] }}>
        {t('rem.remind')}
      </AppText>
      <View style={[styles.wrap, { gap: theme.space[2], marginTop: theme.space[2] }]}>
        {OFFSETS.map((o) =>
          chip(
            `offset-${o}`,
            o === 0 ? t('rem.at_moment') : o === 15 ? t('rem.before15') : o === 60 ? t('rem.before60') : t('rem.day_before'),
            offset === o,
            () => setOffset(o),
          ),
        )}
      </View>
      <AppText variant="meta" style={{ marginTop: theme.space[3] }}>
        {t('rem.no_repeat')}
      </AppText>
      {error ? (
        <AppText testID="rem-error" color="alarm" accessibilityLiveRegion="polite" style={{ marginTop: theme.space[3] }}>
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
  chip: { borderWidth: 1, justifyContent: 'center' },
  step: { borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
