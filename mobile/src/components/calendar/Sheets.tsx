import { Bell, Check, ChevronRight, Clock, Repeat, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, TextInput, View } from 'react-native';

import type { CalEntry } from '@/calendar/entries';
import { repeatKind, ruleFor } from '@/calendar/rrule';
import { hhmm } from '@/calendar/time';
import { ChangedMark } from '@/components/ChangedMark';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { pressedStyle } from '../ui/motion';
import { Sheet } from '../ui/Sheet';
import { TimeWheel } from '../ui/TimeWheel';
import { EntryRows } from './MonthView';
import { dateText, durText } from './parts';

const DURATIONS = [15, 30, 60, 120] as const;
const durKey = (d: number) => `cal.dur_${d}`;
type RepeatKind = 'none' | 'daily' | 'weekly' | 'monthly';
const REPEATS: RepeatKind[] = ['none', 'daily', 'weekly', 'monthly'];

export type AddDraft = { date: string; start: number; duration: number };

/**
 * A4 «Добавить в пустое время»: the title, «Пт, 20 нояб · 15:00», the length (15 мин · 30 мин · 1 ч · 2 ч),
 * «Подробнее» (the time wheel, the repeat, «Без времени») and «Добавить». No «весь день» among the lengths (§13 п. 9).
 */
export function AddSheet({
  draft,
  onChange,
  onClose,
  onAdd,
}: {
  draft: AddDraft;
  onChange: (d: AddDraft) => void;
  onClose: () => void;
  onAdd: (a: { title: string; date: string; start: number | null; duration: number | null; rrule: string | null }) => void;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const c = theme.colors;
  const [title, setTitle] = useState('');
  const [more, setMore] = useState(false);
  const [repeat, setRepeat] = useState<RepeatKind>('none');
  const [untimed, setUntimed] = useState(false);
  const ok = title.trim().length > 0;
  const add = () => {
    if (!ok) return;
    onAdd({
      title: title.trim(),
      date: draft.date,
      start: untimed ? null : draft.start,
      duration: untimed ? null : draft.duration,
      rrule: untimed ? null : ruleFor(repeat),
    });
  };
  return (
    <Sheet visible testID="cal-add" onClose={onClose} closeButton={false} place="tasks">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 }}>
        <View style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: c.ink }} />
        <TextInput
          testID="cal-add-title"
          autoFocus
          value={title}
          onChangeText={setTitle}
          placeholder={t('cal.title_ph')}
          placeholderTextColor={c.ink3}
          returnKeyType="done"
          onSubmitEditing={add}
          maxLength={200}
          style={{ flex: 1, fontFamily: theme.type.headline.fontFamily, fontSize: 20, lineHeight: 25, color: c.ink, paddingVertical: 8 }}
        />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
        <Pressable
          testID="cal-add-when"
          accessibilityRole="button"
          onPress={() => setMore(true)}
          style={({ pressed }) => [timeChip(c.paper2), pressedStyle(pressed)]}
        >
          <Clock size={18} color={c.ink} strokeWidth={theme.icon.strokeWidth} />
          <AppText style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 15, lineHeight: 18, color: c.ink, fontVariant: ['tabular-nums'] }}>
            {untimed ? `${dateText(i18n.language, draft.date, 'short')} · ${t('cal.no_time')}` : `${dateText(i18n.language, draft.date, 'short')} · ${hhmm(draft.start)}`}
          </AppText>
        </Pressable>
      </View>
      {untimed ? null : (
        <View style={{ flexDirection: 'row', gap: 8, paddingTop: 6, paddingBottom: 10 }}>
          {DURATIONS.map((d) => (
            <Chip
              key={d}
              testID={`cal-add-dur-${d}`}
              label={t(durKey(d))}
              variant={draft.duration === d ? 'selected' : 'tonal'}
              selected={draft.duration === d}
              onPress={() => onChange({ ...draft, duration: d })}
              style={{ minHeight: 34, paddingHorizontal: 12 }}
            />
          ))}
        </View>
      )}
      {more ? (
        <View style={{ gap: 10 }}>
          {untimed ? null : (
            <TimeWheel
              testID="cal-add-wheel"
              hour={Math.floor(draft.start / 60)}
              minute={draft.start % 60}
              onChange={(h, m) => onChange({ ...draft, start: h * 60 + m })}
            />
          )}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {REPEATS.map((r) => (
              <Chip key={r} testID={`cal-add-repeat-${r}`} label={t(`cal.repeat_${r}`)} variant={repeat === r && !untimed ? 'selected' : 'tonal'} onPress={() => (setUntimed(false), setRepeat(r))} style={{ minHeight: 34, paddingHorizontal: 12 }} />
            ))}
            <Chip testID="cal-add-untimed" label={t('cal.no_time')} variant={untimed ? 'selected' : 'tonal'} onPress={() => setUntimed((v) => !v)} style={{ minHeight: 34, paddingHorizontal: 12 }} />
          </View>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
        {more ? (
          <View />
        ) : (
          <Pressable testID="cal-add-more" accessibilityRole="button" onPress={() => setMore(true)} hitSlop={10}>
            <AppText style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 15, lineHeight: 18, color: c.ink, textDecorationLine: 'underline' }}>{t('cal.more')}</AppText>
          </Pressable>
        )}
        <Button testID="cal-add-save" label={t('cal.add')} size="small" disabled={!ok} onPress={add} />
      </View>
    </Sheet>
  );
}

const timeChip = (bg: string) => ({
  height: 36,
  borderRadius: 18,
  backgroundColor: bg,
  paddingHorizontal: 12,
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 6,
});

/**
 * A5 «Карточка дела» — one sheet for the whole app (the grid, the plan on «Сегодня», the list, the chat): the title
 * (edited in place), «добавил помощник», four rows of 54 (when with the length, repeat, reminder), «Сделано» and
 * «Удалить» without «Да» (Ф-75). No check by the title: it doubled «Сделано» (§13 п. 7).
 */
export function EntrySheet({
  entry,
  onClose,
  onRename,
  onTime,
  onRepeat,
  onDone,
  onDelete,
  onReminder,
}: {
  entry: CalEntry;
  onClose: () => void;
  onRename: (title: string) => void;
  onTime: (to: { start: number; duration: number | null }) => void;
  onRepeat: (rrule: string | null) => void;
  onDone: () => void;
  onDelete: () => void;
  onReminder: () => void;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const c = theme.colors;
  const [title, setTitle] = useState(entry.title);
  const [editTime, setEditTime] = useState(false);
  const [editRepeat, setEditRepeat] = useState(false);
  const [start, setStart] = useState(entry.start ?? 9 * 60);
  const [dur, setDur] = useState<number | null>(entry.duration ?? 60);
  const kind = repeatKind(entry.rrule);
  const range = entry.start !== null ? (entry.duration ? `${hhmm(entry.start)}–${hhmm(entry.start + entry.duration)} · ${durText(t, entry.duration)}` : hhmm(entry.start)) : t('cal.all_day_short');
  const offsets = entry.remind?.offsets ?? [];
  const remind = offsets.length > 0 ? t('cal.remind_before', { time: durText(t, Math.max(...offsets)) }) : t('cal.remind_none');
  const commitTitle = () => {
    const v = title.trim();
    if (v && v !== entry.title) onRename(v);
  };
  const row = (o: { testID: string; icon: typeof Clock; label: string; value: string; onPress?: () => void; a11y?: string }) => (
    <Pressable
      testID={o.testID}
      accessibilityRole="button"
      accessibilityLabel={o.a11y ?? `${o.label}, ${o.value}`}
      disabled={!o.onPress}
      onPress={o.onPress}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, borderTopWidth: 1, borderTopColor: c.line }, pressedStyle(pressed)]}
    >
      <o.icon size={22} color={c.ink2} strokeWidth={theme.icon.strokeWidth} />
      <AppText numberOfLines={1} style={{ flex: 1, fontSize: 16, lineHeight: 22, color: c.ink }}>
        {o.label}
      </AppText>
      <AppText numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, color: c.ink2, fontVariant: ['tabular-nums'] }}>
        {o.value}
      </AppText>
      {o.onPress ? <ChevronRight size={18} color={c.ink2} strokeWidth={theme.icon.strokeWidth} /> : null}
    </Pressable>
  );
  return (
    <Sheet visible testID="cal-card" onClose={() => (commitTitle(), onClose())} closeButton={false} place="tasks">
      <TextInput
        testID="cal-card-title"
        value={title}
        onChangeText={setTitle}
        onBlur={commitTitle}
        onSubmitEditing={commitTitle}
        returnKeyType="done"
        maxLength={200}
        style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 20, lineHeight: 25, color: c.ink, paddingTop: 4, paddingBottom: 6, minHeight: 52 }}
      />
      <View style={{ marginTop: -6, marginBottom: 4 }}>
        <ChangedMark at={entry.changedAt} actionId={entry.changedBy} testID="cal-card-changed" />
      </View>
      {row({
        testID: 'cal-card-when',
        icon: Clock,
        label: dateText(i18n.language, entry.date),
        value: range,
        a11y: t('cal.time_a11y', { range }),
        onPress: () => setEditTime((v) => !v),
      })}
      {editTime ? (
        <View style={{ gap: 8, paddingBottom: 8 }}>
          <TimeWheel testID="cal-card-wheel" hour={Math.floor(start / 60)} minute={start % 60} onChange={(h, m) => setStart(h * 60 + m)} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {DURATIONS.map((d) => (
              <Chip key={d} testID={`cal-card-dur-${d}`} label={t(durKey(d))} variant={dur === d ? 'selected' : 'tonal'} onPress={() => setDur(d)} style={{ minHeight: 34, paddingHorizontal: 12 }} />
            ))}
          </View>
          <Button
            testID="cal-card-time-save"
            label={t('cal.save')}
            size="small"
            onPress={() => {
              setEditTime(false);
              onTime({ start, duration: dur });
            }}
          />
        </View>
      ) : null}
      {row({
        testID: 'cal-card-repeat',
        icon: Repeat,
        label: t('cal.repeat'),
        value: t(`cal.repeat_${kind}`),
        onPress: entry.kind === 'task' && entry.start !== null ? () => setEditRepeat((v) => !v) : undefined,
      })}
      {editRepeat ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 8 }}>
          {REPEATS.map((r) => (
            <Chip
              key={r}
              testID={`cal-card-repeat-${r}`}
              label={t(`cal.repeat_${r}`)}
              variant={kind === r ? 'selected' : 'tonal'}
              onPress={() => {
                setEditRepeat(false);
                onRepeat(ruleFor(r));
              }}
              style={{ minHeight: 34, paddingHorizontal: 12 }}
            />
          ))}
        </View>
      ) : null}
      {row({ testID: 'cal-card-remind', icon: Bell, label: t('cal.remind'), value: remind, onPress: entry.remind ? onReminder : undefined })}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <View style={{ flex: 1 }}>
          <Button
            testID="cal-card-done"
            label={entry.done ? t('cal.undone') : t('cal.done')}
            icon={<Check size={20} color={c.onBtn} strokeWidth={2.4} />}
            onPress={onDone}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button testID="cal-card-delete" label={t('cal.delete')} variant="secondary" icon={<Trash2 size={20} color={c.ink} strokeWidth={theme.icon.strokeWidth} />} onPress={onDelete} />
        </View>
      </View>
    </Sheet>
  );
}

/** §4 «у повторяющегося»: «Только это / Это и следующие» («Все» is not offered: the past is not touched). */
export function ScopeSheet({ kind, onPick, onClose }: { kind: 'move' | 'delete'; onPick: (s: 'this' | 'following') => void; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet visible testID="cal-scope" title={kind === 'delete' ? t('cal.scope_delete') : t('cal.scope_move')} onClose={onClose} place="tasks">
      <View style={{ gap: 10 }}>
        <Button testID="cal-scope-this" label={t('cal.scope_this')} onPress={() => onPick('this')} />
        <Button testID="cal-scope-following" label={t('cal.scope_following')} variant="secondary" onPress={() => onPick('following')} />
      </View>
    </Sheet>
  );
}

/** «+N» of a crowded hour: the list of that hour. */
export function HourSheet({ title, entries, onOpen, onToggle, onClose }: { title: string; entries: CalEntry[]; onOpen: (e: CalEntry) => void; onToggle: (e: CalEntry) => void; onClose: () => void }) {
  return (
    <Sheet visible testID="cal-hour" title={title} onClose={onClose} place="tasks">
      <EntryRows entries={entries} onOpen={onOpen} onToggle={onToggle} />
    </Sheet>
  );
}
