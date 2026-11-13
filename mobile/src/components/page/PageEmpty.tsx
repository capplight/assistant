import { FileText } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import type { LucideIcon } from '../ui/Icon';

/**
 * An empty page (design-system §3 EmptyState): icon 48 `iconSecondary` in an 88 `surfaceSunken` circle, the
 * phrase `body` ink2, the examples to say under it. No border, no fake cards.
 */
export function PageEmpty({ lines, title, icon: Cmp = FileText }: { lines: string[]; title?: string; icon?: LucideIcon }) {
  const theme = useTheme();
  const d = theme.size.emptyIconCircle;
  const [first, ...rest] = lines;
  return (
    <View testID="page-empty" style={[styles.wrap, { gap: theme.space[3], paddingVertical: theme.space[8] }]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.circle, { width: d, height: d, borderRadius: d / 2, backgroundColor: theme.colors.surfaceSunken }]}
      >
        <Cmp size={theme.size.emptyIcon} color={theme.colors.iconSecondary} strokeWidth={theme.icon.strokeWidth} />
      </View>
      {title ? (
        <AppText variant="title2" accessibilityRole="header" style={styles.text}>
          {title}
        </AppText>
      ) : null}
      {first ? (
        <AppText color="ink2" style={styles.text}>
          {first}
        </AppText>
      ) : null}
      {rest.map((l) => (
        <AppText key={l} variant="callout" style={styles.text}>
          {l}
        </AppText>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  circle: { alignItems: 'center', justifyContent: 'center' },
  text: { textAlign: 'center', maxWidth: 420 },
});
