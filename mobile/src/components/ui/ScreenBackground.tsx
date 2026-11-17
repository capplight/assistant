import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

/** v5: flat — the paper colour, no gradient, no glow (design-system §11.11 «убрать»). */
export function ScreenBackground() {
  const theme = useTheme();
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.paper }]}
    />
  );
}
