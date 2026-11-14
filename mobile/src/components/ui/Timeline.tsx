import { AlarmClock } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme, withAlpha } from '@/theme';

import { AppText } from '../AppText';
import { cardEdge } from './Card';
import { Icon } from './Icon';
import { pressedStyle } from './motion';

export type TimelineItem = {
  key: string;
  /** «09:00», or null for «Без времени». */
  time: string | null;
  title: string;
  meta?: string;
  state: 'past' | 'now' | 'future' | 'missed';
  /** The item is a ring with an alarm clock. */
  alarm?: boolean;
  onDone?: () => void;
  onSnooze?: () => void;
  onPress?: () => void;
  /** The whole row for a screen reader («Пропущено 12:00 · Позвонить в банк»). */
  label?: string;
  testID?: string;
};

/**
 * Timeline «План дня» (design-system v2 §5): the time 44 wide in tabular digits · a 12 dot · a 2 line `separator`.
 * Past: crossed out, `ink3`. Now: the one sun card with «Готово» / «+10 мин». Future: plain. Missed: time in
 * `danger`. One card holds the line; texts wrap at 200 %.
 */
export function Timeline({ items, doneLabel, snoozeLabel, testID }: { items: TimelineItem[]; doneLabel: string; snoozeLabel: string; testID?: string }) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[{ backgroundColor: theme.colors.surface, borderRadius: theme.radius.xl, paddingVertical: theme.space[2], paddingHorizontal: theme.space[1] }, theme.elevation.card, cardEdge(theme)]}
    >
      {items.map((it, i) => {
        const last = i === items.length - 1;
        const now = it.state === 'now';
        const past = it.state === 'past';
        const timeColor = it.state === 'missed' ? theme.colors.danger : now ? theme.colors.onHighlight : theme.colors.ink;
        const row = (
          <View
            style={[
              styles.row,
              {
                gap: theme.space[2],
                paddingVertical: theme.space[2],
                paddingHorizontal: theme.space[1],
                ...(now ? { backgroundColor: theme.colors.highlight, borderRadius: theme.radius.lg, marginHorizontal: 0, paddingVertical: theme.space[3] } : null),
              },
            ]}
          >
            <AppText
              variant="callout"
              style={[styles.time, { color: timeColor, fontFamily: theme.type.button.fontFamily, fontVariant: ['tabular-nums'] }]}
            >
              {it.time ?? ''}
            </AppText>
            <View style={styles.rail}>
              <View
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  borderWidth: 2,
                  marginTop: 4,
                  borderColor: now ? theme.colors.surface : past ? theme.colors.iconSecondary : theme.colors.brand,
                  backgroundColor: past ? theme.colors.iconSecondary : now ? theme.colors.highlight : theme.colors.surface,
                }}
              />
              {!last ? <View style={[styles.line, { backgroundColor: theme.colors.separator }]} /> : null}
            </View>
            <View style={[styles.flex, { gap: 2 }]}>
              <View style={[styles.head, { gap: theme.space[2] }]}>
                <AppText
                  variant={now ? 'headline' : 'body'}
                  style={[styles.flex, { color: now ? theme.colors.onHighlight : past ? theme.colors.ink3 : theme.colors.ink }, past ? styles.struck : null]}
                >
                  {it.title}
                </AppText>
                {now && it.alarm ? <Icon icon={AlarmClock} size="sm" color={theme.colors.onHighlight} /> : null}
              </View>
              {it.meta ? (
                <AppText variant="footnote" style={{ color: now ? theme.colors.onHighlight2 : theme.colors.ink2 }}>
                  {it.meta}
                </AppText>
              ) : null}
              {now && (it.onDone || it.onSnooze) ? (
                <View style={[styles.buttons, { gap: theme.space[2], marginTop: theme.space[2] }]}>
                  {it.onDone ? (
                    <Pressable
                      testID={it.testID ? `${it.testID}-done` : undefined}
                      accessibilityRole="button"
                      accessibilityLabel={`${doneLabel}: ${it.title}`}
                      onPress={it.onDone}
                      style={({ pressed }) => [styles.pillBtn, { minHeight: theme.size.minTouch - 8, borderRadius: theme.radius.round, backgroundColor: theme.colors.onHighlight, paddingHorizontal: theme.space[4] }, pressedStyle(pressed)]}
                    >
                      <AppText variant="callout" style={{ color: theme.colors.highlight, fontFamily: theme.type.button.fontFamily }}>
                        {doneLabel}
                      </AppText>
                    </Pressable>
                  ) : null}
                  {it.onSnooze ? (
                    <Pressable
                      testID={it.testID ? `${it.testID}-snooze` : undefined}
                      accessibilityRole="button"
                      onPress={it.onSnooze}
                      style={({ pressed }) => [
                        styles.pillBtn,
                        { minHeight: theme.size.minTouch - 8, borderRadius: theme.radius.round, backgroundColor: withAlpha('#FFFFFF', 0.45), paddingHorizontal: theme.space[4] },
                        pressedStyle(pressed),
                      ]}
                    >
                      <AppText variant="callout" style={{ color: theme.colors.onHighlight, fontFamily: theme.type.button.fontFamily }}>
                        {snoozeLabel}
                      </AppText>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
          </View>
        );
        if (!it.onPress || now)
          return (
            <View key={it.key} testID={it.testID} accessibilityLabel={it.label}>
              {row}
            </View>
          );
        return (
          <Pressable key={it.key} testID={it.testID} accessibilityRole="button" accessibilityLabel={it.label} onPress={it.onPress} style={({ pressed }) => pressedStyle(pressed)}>
            {row}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  head: { flexDirection: 'row', alignItems: 'flex-start' },
  time: { minWidth: 44, paddingTop: 1 },
  rail: { width: 12, alignItems: 'center', alignSelf: 'stretch' },
  line: { width: 2, flex: 1, marginTop: 2, marginBottom: -12 },
  flex: { flex: 1 },
  struck: { textDecorationLine: 'line-through' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap' },
  pillBtn: { alignItems: 'center', justifyContent: 'center' },
});
