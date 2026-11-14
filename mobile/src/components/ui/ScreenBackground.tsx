import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useTheme } from '@/theme';

/** `rgba(r,g,b,a)` / `#RRGGBB` → colour + opacity for an SVG stop. */
function stop(color: string): { color: string; opacity: number } {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (!m) return { color, opacity: 1 };
  return { color: `rgb(${m[1]},${m[2]},${m[3]})`, opacity: Number(m[4]) };
}

/**
 * The page background v2 (design-system §2 `bg` + `bgGlow`): a vertical gradient `bgGradient` and a soft radial
 * glow over the top ~40 % (light: mint, dark: emerald). Drawn behind the content, never touched by taps or the
 * screen reader.
 */
export function ScreenBackground() {
  const theme = useTheme();
  const [top, bottom] = theme.colors.bgGradient;
  const glow = stop(theme.colors.bgGlow);
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={top} />
            <Stop offset="1" stopColor={bottom} />
          </LinearGradient>
          <RadialGradient id="glow" cx="50%" cy="-8%" rx="120%" ry="50%" fx="50%" fy="-8%">
            <Stop offset="0" stopColor={glow.color} stopOpacity={glow.opacity} />
            <Stop offset="0.7" stopColor={glow.color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#bg)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#glow)" />
      </Svg>
    </View>
  );
}
