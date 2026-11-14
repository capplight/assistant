import { router } from 'expo-router';
import { AlarmClock, BellRing } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { dayText, timeText, wantsAlarm } from '@/alarms/format';
import { deleteReminder, saveReminder } from '@/alarms/service';
import { useAlarms } from '@/alarms/store';
import type { ReminderDraft } from '@/api/types';
import { useReminderCard, type ReminderCard } from '@/store/reminderCard';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
import { Chip } from './ui/Chip';
import { Icon } from './ui/Icon';
import { useReducedMotion } from './ui/motion';

/** The card closes by itself this long after the reminder is set (design-system v2 §4). */
export const CONFIRM_CARD_MS = 5000;

const dueOf = (d: ReminderDraft | null) => (d?.due_at ? Date.parse(d.due_at) : NaN);

/** Saves the chosen reading; returns the local reminder id. */
async function save(card: ReminderCard, d: ReminderDraft): Promise<string | null> {
  const due = dueOf(d);
  if (!Number.isFinite(due) || due <= Date.now() + 30_000) return null;
  const r = await saveReminder({
    title: d.title || card.text,
    dueAt: due,
    level: d.level ?? (wantsAlarm(card.text) ? 'alarm' : 'notification'),
    offsets: d.offsets ?? [],
    createdVia: card.via,
    parseSource: null,
    messageId: card.messageId,
  });
  return r.id;
}

/** S13 as the form, for «Изменить» and for what the card cannot show (no time read). */
export function openReminderForm(card: Pick<ReminderCard, 'text' | 'draft' | 'options' | 'message' | 'messageId' | 'via'>): void {
  const params: Record<string, string> = {};
  if (card.via === 'voice') params.via = card.via;
  if (card.text) params.text = card.text;
  if (card.draft) params.draft = JSON.stringify(card.draft);
  if (card.options.length > 1) params.options = JSON.stringify(card.options);
  if (card.message) params.message = card.message;
  if (card.messageId) params.messageId = card.messageId;
  router.push({ pathname: '/reminder-new', params });
}

/**
 * ConfirmCard (design-system v2 §5, Ф-50 «напоминание голосом — карточка над строкой»): a 46 square with the alarm
 * clock, `eyebrow` «БУДИЛЬНИК ПОСТАВЛЕН», the title `headline`, the day and time; «Готово» (primary) and «Изменить»
 * (tonal); a 3 dp bar shows the 5 s until it closes. Several readings («в 7») first ask with time chips — nothing is
 * set until one is tapped. The first reminder still asks for notifications (S04).
 */
export function ConfirmCard() {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const card = useReminderCard((s) => s.card);
  const close = useReminderCard((s) => s.close);
  const markSaved = useReminderCard((s) => s.saved);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(false);
  const started = useRef<number | null>(null);

  const ambiguous = !!card && card.options.length > 1 && !card.savedId;
  const draft = card?.draft ?? card?.options[0] ?? null;

  // One clear reading: set it at once.
  useEffect(() => {
    if (!card || card.savedId || card.options.length > 1 || started.current === card.id || !draft) return;
    started.current = card.id;
    void save(card, draft).then((id) => {
      if (!id) {
        setError(true);
        return;
      }
      markSaved(id);
      askNotifications(draft.title || card.text);
    });
  }, [card, draft, markSaved]);

  // The 5 s bar and the close.
  const savedAt = card?.savedAt ?? null;
  useEffect(() => {
    if (!savedAt) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    const done = setTimeout(close, CONFIRM_CARD_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(done);
    };
  }, [savedAt, close]);

  if (!card) return null;
  const shown = draft;
  const due = dueOf(shown);
  const alarm = (shown?.level ?? (wantsAlarm(card.text) ? 'alarm' : 'notification')) === 'alarm';
  const when = Number.isFinite(due) ? `${dayText(due, now)} · ${timeText(due)}` : '';
  const left = savedAt ? Math.max(0, 1 - (now - savedAt) / CONFIRM_CARD_MS) : 1;

  const pick = (d: ReminderDraft) => {
    useReminderCard.setState({ card: { ...card, draft: d, options: [] } });
    started.current = null;
  };
  const change = async () => {
    const c = card;
    close();
    if (c.savedId) await deleteReminder(c.savedId);
    openReminderForm(c);
  };

  return (
    <View testID="confirm-card" accessibilityLiveRegion="polite" style={[{ backgroundColor: theme.colors.surfaceRaised, borderRadius: theme.radius.xl, padding: theme.space[3], gap: theme.space[3], overflow: 'hidden' }, theme.elevation.floating]}>
      <View style={[styles.row, { gap: theme.space[3] }]}>
        <View style={[styles.square, { width: 46, height: 46, borderRadius: theme.radius.md, backgroundColor: theme.colors.brandTint }]}>
          <Icon icon={alarm ? AlarmClock : BellRing} color="brand" />
        </View>
        <View style={styles.flex}>
          <AppText testID="confirm-card-state" variant="eyebrow" color="brand">
            {ambiguous ? t('rem.card_when') : error ? t('rem.card_check') : alarm ? t('rem.card_alarm_set') : t('rem.card_set')}
          </AppText>
          <AppText testID="confirm-card-title" variant="headline">
            {shown?.title || card.text}
          </AppText>
          {!ambiguous && when ? (
            <AppText testID="confirm-card-when" variant="callout">
              {when}
            </AppText>
          ) : null}
        </View>
      </View>
      {ambiguous ? (
        <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
          {card.options.map((o, i) => (
            <Chip key={`${o.due_at}-${i}`} testID={`confirm-card-option-${i}`} label={o.due_at ? `${dayText(dueOf(o), now)}, ${timeText(dueOf(o))}` : o.title} onPress={() => pick(o)} />
          ))}
        </View>
      ) : null}
      <View style={[styles.row, { gap: theme.space[2], flexDirection: theme.largeFont ? 'column' : 'row', alignItems: 'stretch' }]}>
        {!ambiguous && !error ? <Button testID="confirm-card-done" label={t('rem.card_done')} onPress={close} style={theme.largeFont ? undefined : styles.flex} /> : null}
        <Button testID="confirm-card-change" label={t('rem.card_change')} variant="secondary" onPress={() => void change()} style={theme.largeFont ? undefined : styles.flex} />
      </View>
      {savedAt && !reduced ? (
        <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.track }}>
          <View testID="confirm-card-bar" style={{ height: 3, borderRadius: 2, width: `${left * 100}%`, backgroundColor: theme.colors.brand }} />
        </View>
      ) : null}
    </View>
  );
}

/** R-12: the first reminder asks for notifications (S04) if nobody asked yet. */
function askNotifications(title: string): void {
  const s = useAlarms.getState();
  if (s.caps?.notifications !== 'granted' && !s.notifyAskedAt) router.push({ pathname: '/notify', params: { saved: title } });
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  square: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
