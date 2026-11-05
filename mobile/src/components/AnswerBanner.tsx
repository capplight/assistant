import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { useAssistant } from '@/store/assistant';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

/**
 * S08 — answer banner above the assistant line. Does not disappear by itself:
 * stays until «Закрыть» or the next request (R-52). Live region, does not steal focus.
 * TODO(week 5): source chips (≤2 + «ещё N») and the AI label for generated answers (ai.label_short, R-06).
 */
export function AnswerBanner() {
  const theme = useTheme();
  const { t } = useTranslation();
  const banner = useAssistant((s) => s.banner);
  const closeBanner = useAssistant((s) => s.closeBanner);
  if (!banner) return null;
  return (
    <View
      testID="answer-banner"
      accessibilityLiveRegion="polite"
      style={[
        styles.box,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.line,
          borderRadius: theme.radius.card,
          padding: theme.space[4],
          marginHorizontal: theme.space[3],
          marginBottom: theme.space[2],
          gap: theme.space[3],
        },
      ]}
    >
      <AppText numberOfLines={2}>{banner.text}</AppText>
      <View style={[styles.row, { gap: theme.space[2], flexDirection: theme.largeFont ? 'column' : 'row' }]}>
        <Button
          testID="answer-open"
          label={t('answer.open')}
          variant="outline"
          style={theme.largeFont ? undefined : styles.flex}
          onPress={() => router.push({ pathname: '/chat', params: { focus: banner.messageId } })}
        />
        <Button
          testID="answer-close"
          label={t('answer.close')}
          variant="text"
          style={theme.largeFont ? undefined : styles.flex}
          onPress={closeBanner}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1 },
  row: {},
  flex: { flex: 1 },
});
