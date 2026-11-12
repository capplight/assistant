import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Chip } from './Chip';
import type { LucideIcon } from './Icon';

type Props = {
  icon: LucideIcon;
  text: string;
  /** One example chip («Скажите: купить молоко»); no fake cards. */
  example?: { label: string; onPress: () => void; testID?: string };
  testID?: string;
};

/** Icon 48 `iconSecondary` in an 88 `surfaceSunken` circle, a `body` ink2 phrase, one example chip. */
export function EmptyState({ icon: Cmp, text, example, testID }: Props) {
  const theme = useTheme();
  const d = theme.size.emptyIconCircle;
  return (
    <View testID={testID} style={[styles.wrap, { gap: theme.space[4], paddingVertical: theme.space[8] }]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.circle, { width: d, height: d, borderRadius: d / 2, backgroundColor: theme.colors.surfaceSunken }]}
      >
        <Cmp size={theme.size.emptyIcon} color={theme.colors.iconSecondary} strokeWidth={theme.icon.strokeWidth} />
      </View>
      <AppText color="ink2" style={styles.text}>
        {text}
      </AppText>
      {example ? <Chip label={example.label} onPress={example.onPress} testID={example.testID} style={styles.center} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  circle: { alignItems: 'center', justifyContent: 'center' },
  text: { textAlign: 'center', maxWidth: 420 },
  center: { alignSelf: 'center' },
});
