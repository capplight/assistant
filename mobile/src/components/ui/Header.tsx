import { ChevronLeft } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Icon, type LucideIcon } from './Icon';
import { pressedStyle } from './motion';

export type HeaderAction = { key: string; icon: LucideIcon; label: string; onPress: () => void; testID?: string };

type BackProps = { onPress: () => void; label?: string; testID?: string };

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
      <Icon icon={ChevronLeft} size="sm" color="brand" />
      <AppText variant="callout" color="brand" style={{ fontFamily: theme.type.sectionLabel.fontFamily }}>
        {text}
      </AppText>
    </Pressable>
  );
}

/** A round 36 button (`surface` + shadow), 48 target: search and ⋯ in the header. */
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
      <View style={[styles.round, { width: s, height: s, borderRadius: s / 2, backgroundColor: theme.colors.surface }, theme.elevation.card]}>
        <Icon icon={icon} size="sm" color="ink" />
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
};

/**
 * Screen header (design-system §3 Header): «‹ Назад» row on stack screens, meta, `largeTitle`, ≤2 round buttons.
 * One line: «Порядок» and «Настроить» live in ⋯. The title wraps (KK at 200 %), the buttons keep their place.
 */
export function Header({ title, meta, back, actions = [], children, testID }: HeaderProps) {
  const theme = useTheme();
  if (__DEV__ && actions.length > 2) console.warn('Header: at most 2 actions; put the rest into ⋯');
  return (
    <View testID={testID} style={{ gap: theme.space[1], paddingBottom: theme.space[2] }}>
      {back ? <BackButton {...back} /> : null}
      <View style={[styles.row, { gap: theme.space[2] }]}>
        <View style={styles.flex}>
          {meta ? <AppText variant="footnote">{meta}</AppText> : null}
          <AppText variant="largeTitle" accessibilityRole="header">
            {title}
          </AppText>
        </View>
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
