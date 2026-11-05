import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type ScrollViewProps } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

type Props = {
  children: ReactNode;
  /** Pinned at the bottom (outside the scroll), e.g. «Подходит». */
  footer?: ReactNode;
  edges?: Edge[];
  scroll?: boolean;
  contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
  testID?: string;
};

/** Paper background, 20/16 pt side padding, ≤600 pt centred on tablets. */
export function Screen({
  children,
  footer,
  edges = ['top', 'bottom'],
  scroll = true,
  contentContainerStyle,
  testID,
}: Props) {
  const theme = useTheme();
  const pad = { paddingHorizontal: theme.screenPadding };
  const inner = <View style={[styles.inner, { maxWidth: theme.size.maxContentWidth }]}>{children}</View>;
  return (
    <SafeAreaView testID={testID} edges={edges} style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[pad, { paddingVertical: theme.space[4] }, styles.center, contentContainerStyle]}
          keyboardShouldPersistTaps="handled"
        >
          {inner}
        </ScrollView>
      ) : (
        <View style={[styles.root, pad, styles.center]}>{inner}</View>
      )}
      {footer ? (
        <View
          style={[
            pad,
            styles.center,
            { paddingVertical: theme.space[3], borderTopWidth: 1, borderTopColor: theme.colors.line },
          ]}
        >
          <View style={[styles.inner, { maxWidth: theme.size.maxContentWidth }]}>{footer}</View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center' },
  inner: { width: '100%', flexGrow: 1 },
});
