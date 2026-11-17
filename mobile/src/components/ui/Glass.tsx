import type { ReactNode } from 'react';
import { Platform, View, type AccessibilityRole, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

/** Kept for old imports: blur support of the device (v5 has no glass). */
export const blurSupported = (): boolean => Platform.OS === 'ios' || (Platform.OS === 'android' && Number(Platform.Version) >= 31);

/** v5: flat sheets — the given fill (default `paper2`), no blur, no hairline. */
export function Glass({
  children,
  style,
  fill,
  testID,
  accessibilityRole,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  fill?: string;
  testID?: string;
  accessibilityRole?: AccessibilityRole;
}) {
  const theme = useTheme();
  return (
    <View testID={testID} accessibilityRole={accessibilityRole} style={[{ backgroundColor: fill ?? theme.colors.surface }, style]}>
      {children}
    </View>
  );
}
