import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { MessageCircle } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { closePending, openPending, refreshPending } from '@/chat/service';
import { useAssistant } from '@/store/assistant';
import { useTheme } from '@/theme';

import { answerNotice } from './answerText';
import { AppText } from './AppText';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Icon } from './ui/Icon';

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
    <View testID="pending-answer" accessibilityLiveRegion="polite" style={{ marginBottom: theme.space[3] }}>
      <Card style={{ gap: theme.space[2] }}>
        <View style={[styles.row, { gap: theme.space[2] }]}>
          <Icon icon={MessageCircle} size="sm" color="brand" />
          <AppText variant="sectionLabel" accessibilityRole="header" style={styles.flex}>
            {t('answer.ready')}
          </AppText>
        </View>
        <AppText testID="pending-answer-text" numberOfLines={2}>
          {body}
        </AppText>
        {message.aiGenerated && message.text ? (
          // The «ИИ» label is shown whole, never cut.
          <AppText variant="footnote">{t('ai.label_short')}</AppText>
        ) : null}
        <View style={[styles.row, { gap: theme.space[2], flexWrap: 'wrap' }]}>
          <Button
            testID="pending-open"
            label={t('answer.open')}
            variant="secondary"
            size="small"
            onPress={() => {
              const id = openPending();
              if (id) router.push({ pathname: '/chat', params: { focus: id } });
            }}
          />
          <Button testID="pending-close" label={t('answer.close')} variant="text" onPress={closePending} />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
