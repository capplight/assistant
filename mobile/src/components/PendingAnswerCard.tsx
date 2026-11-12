import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { closePending, openPending, refreshPending } from '@/chat/service';
import { useAssistant } from '@/store/assistant';
import { useTheme } from '@/theme';

import { answerNotice } from './answerText';
import { AppText } from './AppText';
import { Button } from './ui/Button';

/**
 * «Ответ готов: …» [Открыть ответ] on «Сегодня» (2-design 4.4 п. 3, US-26): an answer that was
 * finished while the person was on another page or away from the app (`banner_pending`, job
 * `chat:complete` on the server). Asked again each time «Сегодня» opens.
 */
export function PendingAnswerCard() {
  const theme = useTheme();
  const { t } = useTranslation();
  const message = useAssistant((s) => (s.pending ? s.messages.find((m) => m.id === s.pending?.messageId) : undefined));

  useFocusEffect(
    useCallback(() => {
      void refreshPending();
    }, []),
  );

  if (!message) return null;
  const body = message.text || answerNotice(message, t) || '';
  return (
    <View
      testID="pending-answer"
      accessibilityLiveRegion="polite"
      style={[
        styles.box,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.separator,
          borderRadius: theme.radius.lg,
          padding: theme.space[4],
          marginBottom: theme.space[6],
          gap: theme.space[2],
        },
      ]}
    >
      <AppText variant="sectionLabel" accessibilityRole="header">
        {t('answer.ready')}
      </AppText>
      <AppText testID="pending-answer-text" numberOfLines={2}>
        {body}
      </AppText>
      {message.aiGenerated && message.text ? (
        <AppText variant="callout" numberOfLines={1}>
          {t('ai.label_short')}
        </AppText>
      ) : null}
      <View style={{ gap: theme.space[2], flexDirection: theme.largeFont ? 'column' : 'row' }}>
        <Button
          testID="pending-open"
          label={t('answer.open')}
          variant="secondary"
          style={theme.largeFont ? undefined : styles.flex}
          onPress={() => {
            const id = openPending();
            if (id) router.push({ pathname: '/chat', params: { focus: id } });
          }}
        />
        <Button
          testID="pending-close"
          label={t('answer.close')}
          variant="text"
          style={theme.largeFont ? undefined : styles.flex}
          onPress={closePending}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1 },
  flex: { flex: 1 },
});
