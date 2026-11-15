import { Check, SunMoon } from 'lucide-react-native';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { darkColors, lightColors, useTheme, type Scheme, type SchemePreference } from '@/theme';

import { AppText } from '../AppText';
import { cardEdge } from './Card';
import { Icon } from './Icon';
import { pressedStyle } from './motion';

/** A tiny drawing of a theme: its page, a white / glass card, two tiles, the sun. */
function Preview({ scheme }: { scheme: Scheme }) {
  const c = scheme === 'dark' ? darkColors : lightColors;
  const block = (flex: number, bg: string, h: number) => <View style={{ flex, height: h, borderRadius: 6, backgroundColor: bg }} />;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ backgroundColor: c.bg, borderRadius: 12, padding: 10, gap: 6 }}
    >
      <View style={{ width: '60%', height: 6, borderRadius: 3, backgroundColor: scheme === 'dark' ? '#5E7D72' : '#2A4A3D' }} />
      {block(0, scheme === 'dark' ? c.surfaceRaised : '#FFFFFF', 30)}
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {block(1, scheme === 'dark' ? c.surfaceRaised : '#FFFFFF', 22)}
        {block(1, c.highlight, 22)}
      </View>
    </View>
  );
}

/**
 * ThemePicker (design-system v2 §5): two big preview cards «Мята / Глубина» with a round ✓, and the switch row
 * «Как в телефоне» (днём Мята, ночью Глубина). Picking a card turns the phone mode off.
 */
export function ThemePicker({
  preference,
  onChange,
  labels,
}: {
  preference: SchemePreference;
  onChange: (p: SchemePreference) => void;
  labels: { light: string; dark: string; system: string; systemHint: string };
}) {
  const theme = useTheme();
  const shown: Scheme = preference === 'system' ? theme.scheme : preference;
  const card = (s: Scheme) => {
    const on = preference !== 'system' && shown === s;
    return (
      <Pressable
        key={s}
        testID={`theme-${s}`}
        accessibilityRole="radio"
        accessibilityState={{ checked: on }}
        accessibilityLabel={s === 'light' ? labels.light : labels.dark}
        onPress={() => onChange(s)}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radius.xl,
            padding: theme.space[2],
            gap: theme.space[2],
            borderWidth: 2,
            borderColor: on ? theme.colors.brand : 'transparent',
          },
          theme.elevation.card,
          pressedStyle(pressed),
        ]}
      >
        <Preview scheme={s} />
        <View style={[styles.row, { paddingHorizontal: theme.space[1], gap: theme.space[2] }]}>
          <AppText variant="headline" style={styles.flex}>
            {s === 'light' ? labels.light : labels.dark}
          </AppText>
          <View
            style={[
              styles.radio,
              { borderColor: on ? theme.colors.brand : theme.colors.iconSecondary, backgroundColor: on ? theme.colors.brand : 'transparent' },
            ]}
          >
            {on ? <Icon icon={Check} size="sm" color="onBrand" /> : null}
          </View>
        </View>
      </Pressable>
    );
  };
  return (
    <View style={{ gap: theme.space[3] }}>
      <View accessibilityRole="radiogroup" style={[styles.row, { gap: theme.space[2], alignItems: 'stretch', flexDirection: theme.largeFont ? 'column' : 'row' }]}>
        {card('light')}
        {card('dark')}
      </View>
      <View
        style={[styles.row, { backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: theme.space[3], gap: theme.space[3] }, theme.elevation.card, cardEdge(theme)]}
      >
        <View style={[styles.square, { backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.sm }]}>
          <Icon icon={SunMoon} size="sm" color="ink2" />
        </View>
        <View style={styles.flex}>
          <AppText>{labels.system}</AppText>
          <AppText variant="footnote">{labels.systemHint}</AppText>
        </View>
        <Switch
          testID="theme-system"
          accessibilityLabel={labels.system}
          value={preference === 'system'}
          onValueChange={(v) => onChange(v ? 'system' : theme.scheme)}
          trackColor={{ true: theme.colors.brand, false: theme.colors.surfaceSunken }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  card: { flex: 1 },
  flex: { flex: 1 },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  square: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
});
