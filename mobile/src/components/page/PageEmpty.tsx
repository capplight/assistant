import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import type { LucideIcon } from '../ui/Icon';

/**
 * An empty page v5 (screens-v5-extra «… · пусто»): no illustration — a short heading and one line how to add,
 * left-aligned on the paper (the strip of the assistant is right below). The icon is kept for old callers only.
 */
export function PageEmpty({ lines, title }: { lines: string[]; title?: string; icon?: LucideIcon }) {
  const theme = useTheme();
  const [first, ...rest] = lines;
  return (
    <View testID="page-empty" style={[styles.wrap, { gap: 6, paddingTop: theme.space[2], paddingBottom: theme.space[6] }]}>
      {title ? (
        <AppText variant="title1" accessibilityRole="header" style={{ fontSize: 24, lineHeight: 29 }}>
          {title}
        </AppText>
      ) : null}
      {first ? <AppText variant="small" style={{ fontSize: 16, lineHeight: 23 }}>{first}</AppText> : null}
      {rest.map((l) => (
        <AppText key={l} variant="small">
          {l}
        </AppText>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'flex-start' },
});
