import { BlurView } from 'expo-blur';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, View, type AccessibilityRole, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

/**
 * Blur is cheap enough from Android 12 (API 31, RenderEffect) and on iOS; older / low-end Android gets the solid
 * `surfaceSolid` fill instead (design-system v2 §7 «Стекло и свечение на слабых Android»).
 */
export const blurSupported = (): boolean => Platform.OS === 'ios' || (Platform.OS === 'android' && Number(Platform.Version) >= 31);

/**
 * The glass of «Глубина» (design-system v2 §2 `surface`): a blur of what is behind + the 80 % tonal fill + a hairline.
 * In «Мята» it is just the given fill (cards are white there). Children sit above the blur.
 */
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
  const dark = theme.scheme === 'dark';
  const bg = fill ?? theme.colors.surface;
  if (!dark) return (
      <View testID={testID} accessibilityRole={accessibilityRole} style={[{ backgroundColor: bg }, style]}>
        {children}
      </View>
    );
  if (!blurSupported()) return (
      <View testID={testID} accessibilityRole={accessibilityRole} style={[style, { backgroundColor: theme.colors.surfaceSolid }]}>
        {children}
      </View>
    );
  return (
    // The fill is drawn over the blur, not under it (an opaque parent would hide what the blur shows).
    <View testID={testID} accessibilityRole={accessibilityRole} style={[styles.clip, style, styles.clear]}>
      <BlurView intensity={40} tint="dark" blurMethod="dimezisBlurViewSdk31Plus" style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: bg }]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  clear: { backgroundColor: 'transparent' },
});
