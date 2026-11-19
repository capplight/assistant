import { usePathname } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAssistant } from '@/store/assistant';
import { resetAskScroll, useChrome } from '@/store/chrome';
import { useView } from '@/store/view';
import { askBar, placeOfTemplate, tabBarV5, useTheme, type PlaceKey } from '@/theme';

import { AnswerBanner } from './AnswerBanner';
import { AssistantLine } from './AssistantLine';
import { BottomTabs } from './BottomTabs';
import { ConfirmCard } from './ConfirmCard';
import { ReminderDraftStrip } from './ReminderCards';
import { ToastLine, useToastAnchor } from './Toast';
import { useAskPlace } from './useAskPlace';
import { useCurrentPage } from './useCurrentPage';
import { aboveLineMaxHeight, useKeyboardHeight } from './useKeyboard';

/**
 * The floating bottom v5 (design-system §11.5, §11.12): it lies OVER the screen (the paper ends above the tabs), so
 * the assistant strip can lie on the paper. Bottom-up: the tab bar on the tray → the assistant strip 10 above it
 * (Ф-82: on the tab screens; the full field 12 above on «Помощник»; none on service screens) → what is above it
 * (the answer card, the reminder draft, the toast), 8 above.
 * Typing: the strip rides 8 above the keyboard and the tabs go under it; what is above scrolls inside a bounded box.
 *
 * QA v5-device-3 J3 / L7: the strip moves WITH the keyboard — a translate on the UI thread from the keyboard's own
 * animation (react-native-keyboard-controller), nothing else re-lays out. The tabs stay where they are (under the
 * keyboard, hidden from screen readers while typing), so the screens above never change their bottom.
 */
export function keyboardLift(o: { tabsHeight: number; gap: number; aboveKeyboard: number }): number {
  // Translate = min(0, −keyboard + lift): the strip's bottom ends `aboveKeyboard` over the keyboard's top.
  return o.tabsHeight + o.gap - o.aboveKeyboard;
}

/**
 * The footer translate for an open keyboard (`keyboard` ≥ 0 dp, the live height while it moves): 0 until the keyboard
 * reaches the strip, then 1:1 with it. Pure (a worklet) for tests.
 */
export function rideOffset(keyboard: number, lift: number): number {
  'worklet';
  return Math.min(0, lift - keyboard);
}
export function MainFooter() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const keyboard = useKeyboardHeight();
  const typing = keyboard > 0;
  const pathname = usePathname();
  // «Я в магазине» (template-screens 3): the line folds to its chip and the mic but stays; no tabs.
  const shop = useView((s) => s.shopMode !== null);
  const tabs = !shop;
  const listening = useAssistant((s) => s.listening);
  const ask = useAskPlace();
  const current = useCurrentPage();
  const place: PlaceKey =
    current.kind === 'today' ? 'today' : current.kind === 'assistant' ? 'assistant' : current.kind === 'page' ? placeOfTemplate(current.page.templateKey) : pathname === '/history' ? 'assistant' : 'stone';
  useEffect(() => {
    useChrome.getState().setPlace(place);
  }, [place]);
  const bottomPad = insets.bottom > 0 ? insets.bottom : 8;
  const tabsHeight = tabs ? tabBarV5.height + bottomPad : 0;
  useToastAnchor();

  useEffect(() => {
    useChrome.getState().setTabBarHeight(tabsHeight);
  }, [tabsHeight]);
  useEffect(() => {
    useChrome.getState().setAskShown(ask !== null);
  }, [ask]);
  // Every tab / screen opens with the strip expanded.
  useEffect(() => {
    resetAskScroll();
  }, [pathname]);

  const gap = ask?.variant === 'full' ? 12 : askBar.aboveTabBar;
  const lift = keyboardLift({ tabsHeight, gap, aboveKeyboard: askBar.aboveKeyboard });
  // The keyboard's height on the UI thread (negative while open: the library's convention).
  const kb = useReanimatedKeyboardAnimation();
  const ride = useAnimatedStyle(() => ({ transform: [{ translateY: rideOffset(-kb.height.value, lift) }] }), [lift]);
  return (
    <View pointerEvents="box-none" style={styles.root}>
      {listening && current.kind !== 'assistant' ? (
        <View
          testID="voice-dim"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height, backgroundColor: theme.colors.scrim }}
        />
      ) : null}
      <View testID="main-footer" pointerEvents="box-none" style={[styles.column, { paddingBottom: 0 }]}>
        {/* Always the same ScrollView (no remount of «Отменить» when the keyboard opens); bounded only while typing. */}
        <Animated.ScrollView
          testID="footer-above-line"
          scrollEnabled={typing}
          style={[{ flexGrow: 0, ...(typing ? { maxHeight: aboveLineMaxHeight(height, keyboard) } : null) }, ride]}
          contentContainerStyle={{ paddingHorizontal: theme.m.ask.inset, gap: theme.space[2], paddingBottom: askBar.noticeGap }}
          keyboardShouldPersistTaps="handled"
        >
          <AnswerBanner />
          <ConfirmCard />
          <ReminderDraftStrip />
          <ToastLine />
        </Animated.ScrollView>
        {ask ? (
          <Animated.View
            testID="assistant-strip-column"
            pointerEvents="box-none"
            style={[{ paddingBottom: gap, width: '100%', maxWidth: 600, alignSelf: 'center', zIndex: 1 }, ride]}
          >
            <AssistantLine compact={shop} keyboardHeight={keyboard} variant={ask.variant} placeholderText={ask.placeholder} />
          </Animated.View>
        ) : null}
        {tabs ? (
          // Under the keyboard while typing: out of reach for screen readers until it closes.
          <View
            testID="bottom-tabs-wrap"
            pointerEvents={typing ? 'none' : 'box-none'}
            accessibilityElementsHidden={typing}
            importantForAccessibility={typing ? 'no-hide-descendants' : 'auto'}
          >
            <BottomTabs bottomInset={bottomPad} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  column: { width: '100%' },
});
