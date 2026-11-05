import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

import { AnswerBanner } from './AnswerBanner';
import { AssistantLine } from './AssistantLine';
import { BottomTabs } from './BottomTabs';

/** Bottom stack, bottom-up: tabs → assistant line → (temporarily) answer banner (2-design §4.3). */
export function MainFooter() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  return (
    <View style={{ backgroundColor: theme.colors.surface, paddingBottom: insets.bottom }}>
      <View style={{ backgroundColor: theme.colors.bg }}>
        <AnswerBanner />
      </View>
      <AssistantLine />
      <BottomTabs />
    </View>
  );
}
