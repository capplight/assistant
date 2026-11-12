import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useView } from '@/store/view';
import { useTheme } from '@/theme';

import { AnswerBanner } from './AnswerBanner';
import { AssistantLine } from './AssistantLine';
import { BottomTabs } from './BottomTabs';
import { ReminderDraftStrip } from './ReminderCards';
import { UndoStrip } from './UndoStrip';
import { aboveLineMaxHeight, useKeyboardHeight } from './useKeyboard';

/**
 * Bottom stack, bottom-up: tabs → assistant line → (temporarily) answer banner (2-design §4.3).
 * Typing (week 17): the line sits right on the keyboard («поле над клавиатурой»), the tabs step
 * aside until the keyboard closes, and what is above the line («Отменить», the answer) keeps its
 * place in the same column but scrolls inside a bounded box, so at 200% it can never push the
 * line under the keyboard or cover it.
 */
export function MainFooter() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { height } = useWindowDimensions();
  const keyboard = useKeyboardHeight();
  const typing = keyboard > 0;
  // «Я в магазине» (template-screens 3): the line folds to its chip and the mic but stays; no tabs.
  const shop = useView((s) => s.shopMode !== null);
  const above = (
    <>
      <View style={{ backgroundColor: theme.colors.bg }}>
        <AnswerBanner />
      </View>
      <ReminderDraftStrip />
      <UndoStrip />
    </>
  );
  return (
    // The keyboard covers the home indicator / navigation bar: no safe-area gap under the line then.
    <View testID="main-footer" style={{ backgroundColor: theme.colors.surface, paddingBottom: typing ? 0 : insets.bottom }}>
      {/* Always the same ScrollView (no remount of «Отменить» when the keyboard opens); bounded only while typing. */}
      <ScrollView
        testID="footer-above-line"
        scrollEnabled={typing}
        style={{ flexGrow: 0, ...(typing ? { maxHeight: aboveLineMaxHeight(height, keyboard) } : null) }}
        keyboardShouldPersistTaps="handled"
      >
        {above}
      </ScrollView>
      <AssistantLine compact={shop} keyboardHeight={keyboard} />
      {shop || typing ? null : <BottomTabs />}
    </View>
  );
}
