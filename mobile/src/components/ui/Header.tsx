import { ChevronLeft } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Icon, type LucideIcon } from './Icon';
import { pressedStyle } from './motion';

export type HeaderAction = { key: string; icon: LucideIcon; label: string; onPress: () => void; testID?: string };

/** `iconOnly` (calendar-time.md §14.2): only the arrow «‹» (48 target, chevron 22, −14 left); the label is for screen readers. */
type BackProps = { onPress: () => void; label?: string; testID?: string; iconOnly?: boolean };

/** «‹ Назад»: brand, 15, chevron 20 — only on stack screens. One component instead of the four variants. */
export function BackButton({ onPress, label, testID = 'header-back' }: BackProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const text = label ?? t('common.back');
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={text}
      onPress={onPress}
      style={({ pressed }) => [styles.back, { minHeight: theme.size.minTouch, paddingRight: theme.space[2] }, pressedStyle(pressed)]}
    >
      <Icon icon={ChevronLeft} size="sm" color="linkOnBg" />
      <AppText variant="callout" color="linkOnBg" style={{ fontFamily: theme.type.sectionLabel.fontFamily }}>
        {text}
      </AppText>
    </Pressable>
  );
}

/** v5: a plain 40 icon button (`.ib`), 48 target: search and ⋯. */
export function HeaderButton({ icon, label, onPress, testID }: Omit<HeaderAction, 'key'>) {
  const theme = useTheme();
  const s = theme.size.headerButton;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.target, { width: theme.size.minTouch, height: theme.size.minTouch }, pressedStyle(pressed)]}
    >
      <View style={[styles.round, { width: s, height: s, borderRadius: s / 2 }]}>
        <Icon icon={icon} size="md" color="ink" />
      </View>
    </Pressable>
  );
}

type HeaderProps = {
  title: string;
  /** `footnote` line above the title (a date, a count). */
  meta?: string;
  back?: BackProps;
  /** Up to two round buttons on the right (search, ⋯); more go into ⋯. */
  actions?: HeaderAction[];
  /** Under the title (a segmented control); stays inside the header. */
  children?: ReactNode;
  testID?: string;
  /** testID of the title text (screens whose tests look for their title). */
  titleTestID?: string;
  /** v2: a small control between the title and the buttons (the «сетка / список» toggle of «Заметки»). */
  accessory?: ReactNode;
};

/**
 * Screen header (design-system §3 Header): «‹ Назад» row on stack screens, meta, `largeTitle`, ≤2 round buttons.
 * One line: «Порядок» and «Настроить» live in ⋯. The title wraps (KK at 200 %), the buttons keep their place.
 */
export function Header({ title, meta, back, actions = [], children, testID, titleTestID, accessory }: HeaderProps) {
  const theme = useTheme();
  if (__DEV__ && actions.length > 2) console.warn('Header: at most 2 actions; put the rest into ⋯');
  return (
    <View testID={testID} style={{ gap: theme.space[1], paddingBottom: theme.space[2] }}>
      {back ? <BackButton {...back} /> : null}
      <View style={[styles.row, { gap: theme.space[2] }]}>
        <View style={styles.flex}>
          {meta ? <AppText variant="footnote">{meta}</AppText> : null}
          <AppText testID={titleTestID} variant="largeTitle" accessibilityRole="header">
            {title}
          </AppText>
        </View>
        {accessory}
        {actions.slice(0, 2).map((a) => (
          <HeaderButton key={a.key} icon={a.icon} label={a.label} onPress={a.onPress} testID={a.testID} />
        ))}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 2 },
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  flex: { flex: 1 },
  target: { alignItems: 'center', justifyContent: 'center' },
  round: { alignItems: 'center', justifyContent: 'center' },
});
