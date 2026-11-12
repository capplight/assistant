import { Pressable, StyleSheet, View } from 'react-native';

import { useLayout, useTheme, withAlpha } from '@/theme';

import { AppText } from '../AppText';
import type { LucideIcon } from './Icon';

export type TabItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * The floating tab bar (design-system §3 TabBar): a capsule 12 from the sides and the bottom (+ safe area),
 * min 60 high, `surface` 96 % + floating shadow, ≤600 wide and centred on tablets. ≤4 cells: icon 24 + `tabLabel`;
 * active = a 56×30 `brandTint` pill, brand icon and label; inactive icon `iconSecondary`, label `ink2`.
 * Labels wrap, never cut (KK at 200 %); the capsule grows instead.
 */
export function TabBar({ tabs, bottomInset = 0, testID = 'bottom-tabs' }: { tabs: TabItem[]; bottomInset?: number; testID?: string }) {
  const theme = useTheme();
  const layout = useLayout();
  const inset = theme.size.tabBarInset;
  return (
    <View style={[styles.outer, { paddingHorizontal: inset, paddingBottom: inset + bottomInset }]}>
      <View
        accessibilityRole="tablist"
        testID={testID}
        style={[
          styles.bar,
          {
            minHeight: theme.size.tabBar,
            maxWidth: layout.contentMaxWidth,
            borderRadius: theme.radius.round,
            backgroundColor: withAlpha(theme.colors.surface, 0.96),
            paddingHorizontal: theme.space[1],
            paddingVertical: theme.space[1] + 2,
          },
          theme.elevation.floating,
        ]}
      >
        {tabs.map((tab) => {
          const Cmp = tab.icon;
          const fg = tab.active ? theme.colors.brand : theme.colors.ink2;
          return (
            <Pressable
              key={tab.key}
              testID={tab.testID ?? `tab-${tab.key}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab.active }}
              accessibilityLabel={tab.accessibilityLabel ?? tab.label}
              onPress={tab.onPress}
              style={[styles.tab, { minHeight: theme.size.minTouch, gap: 2 }]}
            >
              <View
                style={[
                  styles.pill,
                  {
                    width: theme.size.tabPill.width,
                    height: theme.size.tabPill.height,
                    borderRadius: theme.radius.round,
                    backgroundColor: tab.active ? theme.colors.brandTint : 'transparent',
                  },
                ]}
              >
                <Cmp size={theme.size.icon} color={tab.active ? theme.colors.brand : theme.colors.iconSecondary} strokeWidth={theme.icon.strokeWidth} />
              </View>
              <AppText variant="tabLabel" style={[styles.label, { color: fg, fontFamily: tab.active ? theme.type.sectionLabel.fontFamily : theme.type.tabLabel.fontFamily }]}>
                {tab.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { alignItems: 'center' },
  bar: { flexDirection: 'row', width: '100%' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  pill: { alignItems: 'center', justifyContent: 'center' },
  label: { textAlign: 'center' },
});
