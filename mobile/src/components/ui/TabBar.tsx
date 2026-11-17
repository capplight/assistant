import { Pressable, StyleSheet, View } from 'react-native';

import { onPlace, tabBarV5, useTheme, type PlaceKey } from '@/theme';

import { AppText } from '../AppText';
import type { LucideIcon } from './Icon';

export type TabItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  onPress: () => void;
  /** The place whose colour the capsule carries («Ещё» → stone). */
  place?: PlaceKey;
  /** v2: the raised centre; v5 draws it like the others (kept for the testID). */
  centre?: boolean;
  accessibilityLabel?: string;
  testID?: string;
};

/** Tab labels never grow past 13 dp (12 × 1.083). */
export const TAB_LABEL_MAX_SCALE = 13 / 12;
/** The smallest a label may shrink to fit its cell. */
export const TAB_LABEL_MIN_SCALE = 0.8;

/** The cells of the bar for a window: 5 equal columns inside 4 dp side padding (the bar spans the window). */
export function tabBarMetrics(o: { windowWidth: number; count: number; contentMaxWidth?: number; inset?: number; padding?: number }) {
  const padding = o.padding ?? 4;
  const bar = Math.min(o.windowWidth, o.contentMaxWidth ?? o.windowWidth);
  const cell = (bar - padding * 2) / Math.max(1, o.count);
  const pill = Math.min(tabBarV5.capsule.widthActive, Math.floor(cell - 2));
  return { bar, cell, pill, label: Math.floor(cell - 2) };
}

/**
 * Tab bar v5 (design-system §11.5): on the dark tray, 68 high + the bottom safe area; five equal cells, each a
 * capsule 46 × 30 in the place colour with its icon and the word under it (`tabLabel` 12, `trayInk2`) — the word is
 * always shown, for older people. Active: capsule 58 wide, a `trayInk` ring 1.5 with a 2 gap, the word `trayInk` 800.
 * ≤ 340 dp: capsules 42 / 52, labels 11.5. With a large system font the label stops at 13.
 */
export function TabBar({ tabs, bottomInset = 0, testID = 'bottom-tabs' }: { tabs: TabItem[]; bottomInset?: number; testID?: string }) {
  const theme = useTheme();
  const m = theme.m;
  const ring = tabBarV5.ring;
  return (
    <View style={{ backgroundColor: theme.colors.tray, minHeight: tabBarV5.height + bottomInset, paddingTop: tabBarV5.padTop, paddingBottom: bottomInset }}>
    {/* The cells stay in a ≤ 600 column on tablets; the tray spans the window. */}
    <View accessibilityRole="tablist" testID={testID} style={[styles.bar, { maxWidth: 600 }]}>
      {tabs.map((tab) => {
        const Cmp = tab.icon;
        const place: PlaceKey = tab.place ?? 'stone';
        const on = onPlace(theme.colors, place);
        const w = tab.active ? m.tab.capsuleActive : m.tab.capsule;
        const pill = (
          <View
            testID={`tab-${tab.key}-${tab.centre ? 'circle' : 'pill'}`}
            style={[styles.capsule, { width: w, height: tabBarV5.capsule.height, borderRadius: tabBarV5.capsule.radius, backgroundColor: theme.colors.place[place] }]}
          >
            <Cmp size={20} color={on.ink} strokeWidth={theme.icon.strokeWidth} />
          </View>
        );
        const out = ring.gap + ring.width;
        return (
          <Pressable
            key={tab.key}
            testID={tab.testID ?? `tab-${tab.key}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab.active }}
            accessibilityLabel={tab.accessibilityLabel ?? tab.label}
            onPress={tab.onPress}
            style={[styles.tab, { minHeight: theme.size.minTouch, gap: tabBarV5.labelGap }]}
          >
            {tab.active ? (
              <View
                style={{
                  margin: -out,
                  padding: ring.gap,
                  borderWidth: ring.width,
                  borderColor: theme.colors.trayInk,
                  borderRadius: tabBarV5.capsule.radius + out,
                }}
              >
                {pill}
              </View>
            ) : (
              pill
            )}
            <AppText
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={TAB_LABEL_MIN_SCALE}
              nativeID="v5-capped"
              maxFontSizeMultiplier={m.tab.labelMaxScale}
              style={[
                theme.type.tabLabel,
                styles.label,
                {
                  fontSize: m.tab.labelSize,
                  color: tab.active ? theme.colors.trayInk : theme.colors.trayInk2,
                  fontFamily: tab.active ? theme.type.title.fontFamily : theme.type.tabLabel.fontFamily,
                },
              ]}
            >
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
  bar: { flexDirection: 'row', width: '100%', alignSelf: 'center', paddingHorizontal: 4, alignItems: 'flex-start' },
  tab: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'flex-start' },
  capsule: { alignItems: 'center', justifyContent: 'center' },
  label: { textAlign: 'center', alignSelf: 'stretch' },
});
