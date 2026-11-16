import { Pressable, StyleSheet, View } from 'react-native';

import { useLayout, useTheme, withAlpha } from '@/theme';

import { AppText } from '../AppText';
import { Glass } from './Glass';
import type { LucideIcon } from './Icon';

export type TabItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  onPress: () => void;
  /** v2: «Расходы» — the emerald circle in the centre, raised above the bar. */
  centre?: boolean;
  accessibilityLabel?: string;
  testID?: string;
};

/** Tab labels never grow past this (iOS does not scale tab labels either); they shrink to fit instead of cutting. */
export const TAB_LABEL_MAX_SCALE = 1.5;
/** The smallest a label may shrink to fit its cell (adjustsFontSizeToFit). */
export const TAB_LABEL_MIN_SCALE = 0.7;

/**
 * The cells of the bar for a window: the capsule is ≤600 wide, 12 from the sides, 4 inside; each of `count` cells
 * gets an equal share, the active pill is at most 68 wide and never wider than its cell (5 tabs on 320 dp).
 */
export function tabBarMetrics(o: { windowWidth: number; count: number; contentMaxWidth?: number; inset?: number; padding?: number }) {
  const inset = o.inset ?? 12;
  const padding = o.padding ?? 4;
  const bar = Math.min(o.windowWidth - inset * 2, o.contentMaxWidth ?? 600);
  const cell = (bar - padding * 2) / Math.max(1, o.count);
  const pill = Math.min(68, Math.floor(cell - 2));
  return { bar, cell, pill, label: pill - 8 };
}

/**
 * The floating tab bar v2 (design-system v2 §5 TabBar v2): a capsule 72 high, 12 from the sides and the bottom
 * (+ safe area), `tabBar` fill + floating shadow, ≤600 wide and centred on tablets. Up to 5 cells; the active one is a
 * `tabPill` «таблетка» 68×56 holding its icon and label (brand); inactive icon `iconSecondary`, label `ink2`.
 * The centre tab («Расходы») is a 60 `brand` circle with an `onBrand` icon, raised by 20, a 4 ring in `fade` and the
 * `brandGlow`; its label stays below in `brand` 600. Labels fit their cell: one line, shrinking (never cut) and
 * capped at ×1.5 with the system font.
 */
export function TabBar({ tabs, bottomInset = 0, testID = 'bottom-tabs' }: { tabs: TabItem[]; bottomInset?: number; testID?: string }) {
  const theme = useTheme();
  const layout = useLayout();
  const inset = theme.size.tabBarInset;
  const m = tabBarMetrics({ windowWidth: layout.width, count: tabs.length, contentMaxWidth: layout.contentMaxWidth, inset, padding: theme.space[1] });
  const hasCentre = tabs.some((t) => t.centre);
  const lift = theme.size.centreTabLift;
  const circle = theme.size.centreTab;
  const ring = 4;
  return (
    <View style={[styles.outer, { paddingHorizontal: inset, paddingBottom: inset + bottomInset, paddingTop: hasCentre ? lift : 0 }]}>
      <Glass
        fill={theme.colors.tabBar}
        accessibilityRole="tablist"
        testID={testID}
        style={[
          styles.bar,
          {
            minHeight: theme.size.tabBar,
            maxWidth: layout.contentMaxWidth,
            borderRadius: theme.radius.round,
            paddingHorizontal: theme.space[1],
            paddingVertical: theme.space[1] + 2,
          },
          theme.elevation.floating,
          theme.colors.glassBorder ? { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.glassBorder } : theme.elevation.ring,
        ]}
      >
        {tabs.map((tab) => {
          const Cmp = tab.icon;
          const label = (
            <AppText
              variant="tabLabel"
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={TAB_LABEL_MIN_SCALE}
              maxFontSizeMultiplier={TAB_LABEL_MAX_SCALE}
              style={[
                styles.label,
                {
                  maxWidth: tab.centre ? m.cell : m.label,
                  color: tab.active || tab.centre ? theme.colors.brand : theme.colors.ink2,
                  fontFamily: tab.active || tab.centre ? theme.type.button.fontFamily : theme.type.tabLabel.fontFamily,
                },
              ]}
            >
              {tab.label}
            </AppText>
          );
          if (tab.centre) {
            return (
              <Pressable
                key={tab.key}
                testID={tab.testID ?? `tab-${tab.key}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab.active }}
                accessibilityLabel={tab.accessibilityLabel ?? tab.label}
                onPress={tab.onPress}
                style={[styles.tab, { minHeight: theme.size.minTouch, justifyContent: 'flex-end', gap: 2 }]}
              >
                <View
                  testID={`tab-${tab.key}-circle`}
                  style={[
                    styles.round,
                    {
                      width: circle + ring * 2,
                      height: circle + ring * 2,
                      borderRadius: (circle + ring * 2) / 2,
                      marginTop: -lift - ring - theme.space[1] - 2,
                      // v3 §9.1: the open «Помощник» gets a 3 dp `brand` 33 % ring instead of a pill.
                      backgroundColor: tab.active ? withAlpha(theme.colors.brand, 0.33) : theme.colors.fade,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.round,
                      { width: circle, height: circle, borderRadius: circle / 2, backgroundColor: theme.colors.brand },
                      { shadowColor: theme.colors.brand, shadowOffset: { width: 0, height: 6 }, shadowRadius: 18, shadowOpacity: 0.55, elevation: 8 },
                    ]}
                  >
                    <Cmp size={theme.size.iconLg} color={theme.colors.onBrand} strokeWidth={theme.icon.strokeWidth} />
                  </View>
                </View>
                {label}
              </Pressable>
            );
          }
          return (
            <Pressable
              key={tab.key}
              testID={tab.testID ?? `tab-${tab.key}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab.active }}
              accessibilityLabel={tab.accessibilityLabel ?? tab.label}
              onPress={tab.onPress}
              style={[styles.tab, { minHeight: theme.size.minTouch }]}
            >
              <View
                testID={`tab-${tab.key}-pill`}
                style={[
                  styles.pill,
                  {
                    width: m.pill,
                    minHeight: theme.size.tabPill.height,
                    borderRadius: theme.radius.round,
                    backgroundColor: tab.active ? theme.colors.tabPill : 'transparent',
                    gap: 3,
                  },
                ]}
              >
                <Cmp size={theme.size.iconSm + 2} color={tab.active ? theme.colors.brand : theme.colors.iconSecondary} strokeWidth={theme.icon.strokeWidth} />
                {label}
              </View>
            </Pressable>
          );
        })}
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { alignItems: 'center' },
  bar: { flexDirection: 'row', width: '100%', alignItems: 'center' },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pill: { alignItems: 'center', justifyContent: 'center', paddingVertical: 4 },
  round: { alignItems: 'center', justifyContent: 'center' },
  label: { textAlign: 'center' },
});
