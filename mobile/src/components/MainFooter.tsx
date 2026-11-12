import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useView } from '@/store/view';
import { useLayout, useTheme } from '@/theme';

import { AnswerBanner } from './AnswerBanner';
import { AssistantLine } from './AssistantLine';
import { BottomTabs } from './BottomTabs';
import { ReminderDraftStrip } from './ReminderCards';
import { ToastLine, useToastAnchor } from './Toast';
import { BottomFade } from './ui/BottomFade';
import { UndoStrip } from './UndoStrip';
import { aboveLineMaxHeight, useKeyboardHeight } from './useKeyboard';

/**
 * The floating bottom (design-system §3), bottom-up: tab bar capsule → assistant capsule (8 above) → what is
 * above it (answer, reminder draft, «Отменить» as a toast). The whole column is ≤600 and centred on tablets;
 * the content above dissolves into it (`BottomFade`).
 * Typing (week 17): the capsule sits right on the keyboard, the tabs step aside until the keyboard closes, and
 * what is above keeps its place in the same column but scrolls inside a bounded box, so at 200% it can never
 * push the capsule under the keyboard or cover it.
 */
export function MainFooter() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const layout = useLayout();
  const { height } = useWindowDimensions();
  const keyboard = useKeyboardHeight();
  const typing = keyboard > 0;
  // «Я в магазине» (template-screens 3): the line folds to its chip and the mic but stays; no tabs.
  const shop = useView((s) => s.shopMode !== null);
  const tabs = !(shop || typing);
  useToastAnchor();
  return (
    // The keyboard covers the home indicator / navigation bar: no safe-area gap under the line then.
    // Landscape side insets come from the root stack (app/_layout.tsx).
    <View style={{ backgroundColor: theme.colors.fade }}>
      <BottomFade />
      <View
        testID="main-footer"
        style={[styles.column, { maxWidth: layout.contentMaxWidth, paddingTop: theme.space[1], paddingBottom: typing ? 0 : insets.bottom }]}
      >
        {/* Always the same ScrollView (no remount of «Отменить» when the keyboard opens); bounded only while typing. */}
        <ScrollView
          testID="footer-above-line"
          scrollEnabled={typing}
          style={{ flexGrow: 0, ...(typing ? { maxHeight: aboveLineMaxHeight(height, keyboard) } : null) }}
          contentContainerStyle={{ paddingHorizontal: theme.size.tabBarInset, gap: theme.space[2], paddingBottom: theme.space[1] }}
          keyboardShouldPersistTaps="handled"
        >
          <AnswerBanner />
          <ReminderDraftStrip />
          <UndoStrip />
          <ToastLine />
        </ScrollView>
        <AssistantLine compact={shop} keyboardHeight={keyboard} />
        {tabs ? (
          <View style={{ paddingTop: theme.size.capsuleGap }}>
            <BottomTabs />
          </View>
        ) : (
          <View style={{ height: theme.space[2] }} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { width: '100%', alignSelf: 'center' },
});
