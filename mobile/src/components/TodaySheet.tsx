import { router } from 'expo-router';
import { BellRing, ChevronRight, Clock, Search } from 'lucide-react-native';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { CheckCircle } from './ui/Check';
import { Header } from './ui/Header';
import { Icon } from './ui/Icon';
import { pressedStyle } from './ui/motion';

/**
 * «Сегодня» header (design-system §4 mock): the weekday and date as the `footnote` meta, «Сегодня» as the
 * large title, one round button (search). The date is the screen's header for screen readers.
 */
export function TodayHeader({ now }: { now: number }) {
  const { t, i18n } = useTranslation();
  const d = new Date(now);
  let date: string;
  try {
    date = d.toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    date = d.toDateString();
  }
  const meta = date.charAt(0).toUpperCase() + date.slice(1);
  return (
    <View testID="today-header">
      <Header
        title={t('today.today')}
        meta={meta}
        actions={[{ key: 'search', icon: Search, label: t('today.search'), onPress: () => router.navigate('/search'), testID: 'today-search' }]}
      />
    </View>
  );
}

export type NextItem =
  | { kind: 'reminder'; key: string; title: string; at: number; alarm: boolean }
  | { kind: 'task'; key: string; title: string; at: null };

/**
 * «Дальше» — the one sun card of the screen (design-system §3 NextCard): meta `footnote` onHighlight2,
 * the time large, the title `title2`, [Сделано] dark on the sun and [Отложить] translucent.
 */
export function NextCard({
  next,
  now,
  onDone,
  onSnooze,
}: {
  next: NextItem;
  now: number;
  onDone: () => void;
  onSnooze?: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  let when = '';
  if (next.at !== null) {
    const min = Math.max(0, Math.round((next.at - now) / 60_000));
    when = min < 1 ? t('today.next_now') : min < 60 ? t('today.next_in_min', { n: min }) : t('today.next_in_h', { h: Math.floor(min / 60), m: min % 60 });
  }
  const time = next.at !== null ? new Date(next.at).toTimeString().slice(0, 5) : '';
  const label = [t('today.next'), when, time, next.title].filter(Boolean).join('. ');
  return (
    <Card testID="today-next" tone="highlight" style={{ gap: theme.space[3], marginBottom: theme.space[2] }}>
      <View accessible accessibilityLabel={label} style={{ gap: theme.space[1] }}>
        <View style={[styles.row, { gap: theme.space[1] }]}>
          <Icon icon={next.kind === 'reminder' ? BellRing : Clock} size="sm" color="onHighlight2" />
          <AppText variant="footnote" color="onHighlight2" style={styles.flex}>
            {when ? `${t('today.next')} · ${when}` : t('today.next')}
          </AppText>
        </View>
        {time ? (
          <AppText variant="time" color="onHighlight">
            {time}
          </AppText>
        ) : null}
        <AppText variant="title2" color="onHighlight">
          {next.title}
        </AppText>
      </View>
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        <Button
          testID="today-next-done"
          tone="highlight"
          size="small"
          label={t('alarm.done')}
          accessibilityLabel={`${t('alarm.done')}: ${next.title}`}
          onPress={onDone}
        />
        {onSnooze ? (
          <Button
            testID="today-next-snooze"
            tone="highlight"
            variant="secondary"
            size="small"
            label={t('alarm.snooze_short')}
            accessibilityLabel={t('alarm.snooze')}
            onPress={onSnooze}
          />
        ) : null}
      </View>
    </Card>
  );
}

/** A row of the day's list: a 24 circle (48 target), the title, the time on the right (`danger` when overdue). */
export function TodayRow({
  title,
  time,
  overdue,
  done,
  onToggle,
  onPress,
  label,
  testID,
  checkTestID,
  separator,
}: {
  title: string;
  time?: string;
  overdue?: boolean;
  done: boolean;
  onToggle: () => void;
  onPress?: () => void;
  /** Spoken line (e.g. «Пропущено 10:00 · Позвонить»). */
  label?: string;
  testID?: string;
  checkTestID?: string;
  separator: boolean;
}) {
  const theme = useTheme();
  const body = (
    <View
      style={[
        styles.row,
        styles.flex,
        { minHeight: theme.size.rowHeight, gap: theme.space[2], paddingRight: theme.space[3], paddingVertical: theme.space[1] },
        separator ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.separator } : null,
      ]}
    >
      <AppText color={done ? 'ink3' : 'ink'} style={[styles.flex, done ? styles.struck : null]}>
        {title}
      </AppText>
      {time ? (
        <AppText variant="callout" color={overdue && !done ? 'danger' : done ? 'ink3' : 'ink2'} style={overdue && !done ? { fontFamily: theme.type.sectionLabel.fontFamily } : undefined}>
          {time}
        </AppText>
      ) : null}
    </View>
  );
  return (
    <View testID={testID} accessibilityLabel={label} style={[styles.row, { paddingLeft: theme.space[1] }]}>
      <CheckCircle testID={checkTestID} checked={done} label={label ?? title} onChange={onToggle} />
      {onPress ? (
        <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} onPress={onPress} style={({ pressed }) => [styles.flex, pressedStyle(pressed)]}>
          {body}
        </Pressable>
      ) : (
        body
      )}
    </View>
  );
}

/** The section label above a card («На сегодня · 3 из 4»): `sectionLabel`, no caps. */
export function SectionLabel({ title, value, link }: { title: string; value?: string; link?: { label: string; onPress: () => void; testID?: string } }) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { paddingHorizontal: theme.space[1], marginTop: theme.space[4], marginBottom: theme.space[2], gap: theme.space[2] }]}>
      <AppText variant="sectionLabel" accessibilityRole="header" style={styles.flex}>
        {title}
      </AppText>
      {value ? <AppText variant="callout">{value}</AppText> : null}
      {link ? (
        // «Все дела · 6 ›» (v4 «Сегодня»): a quiet brand link, a full touch target.
        <Pressable testID={link.testID} accessibilityRole="link" onPress={link.onPress} hitSlop={12} style={({ pressed }) => [styles.row, { gap: 2, minHeight: 32 }, pressedStyle(pressed)]}>
          <AppText variant="callout" color="brand">
            {link.label}
          </AppText>
          <Icon icon={ChevronRight} size="sm" color="brand" />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A list card of the day: rows without borders, inset dividers. */
export function DayCard({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Card testID={testID} padded={false} style={styles.clip}>
      {children}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  struck: { textDecorationLine: 'line-through' },
  clip: { overflow: 'hidden' },
});
