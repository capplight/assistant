import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useTheme } from '@/theme';

/**
 * The fade over the content right above the floating bottom (design-system §3 TabBar: «содержимое мягко
 * растворяется»). Drawn above the footer, never takes touches, hidden from screen readers.
 */
export function BottomFade({ height = 24, testID = 'bottom-fade' }: { height?: number; testID?: string }) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.fade, { top: -height, height }]}
    >
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="bottomFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={theme.colors.fade} stopOpacity={0} />
            <Stop offset="1" stopColor={theme.colors.fade} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#bottomFade)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  fade: { position: 'absolute', left: 0, right: 0 },
});
