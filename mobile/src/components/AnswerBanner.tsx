import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { markDelivery, retry } from '@/chat/service';
import { useSavedLine } from '@/store/connectivity';
import { useAssistant } from '@/store/assistant';
import { useTheme } from '@/theme';

import { answerNotice, useLocalHitTitles } from './answerText';
import { AppText } from './AppText';
import { Button } from './Button';
import { LocalHitChips, SourceChips } from './SourceChips';

/**
 * S08 — answer banner above the assistant line (2-design §4.4 п. 2). Up to 2 lines of the answer,
 * ≤2 source chips + «ещё N», the AI label in one line, [Открыть ответ] [Закрыть]. It does not go
 * away by itself: it stays until «Закрыть» or the next request (R-52). Live region, does not take
 * focus. It shows one message of the conversation, so it follows the stream as it comes.
 * TODO(week 6): waits on «Сегодня» when the person left the page (`banner_pending`, push «Ответ готов»).
 */
export function AnswerBanner() {
  const theme = useTheme();
  const { t } = useTranslation();
  const banner = useAssistant((s) => s.banner);
  const message = useAssistant((s) => (s.banner ? s.messages.find((m) => m.id === s.banner?.messageId) : undefined));
  const closeBanner = useAssistant((s) => s.closeBanner);
  const savedLine = useSavedLine();
  // «Нашёл у себя» while nothing else is there yet, and offline.
  const localOnly = !!message && (message.status === 'queued' || (message.status === 'streaming' && !message.text && !message.sources?.length));
  const titles = useLocalHitTitles(localOnly ? message?.localHits : undefined, t);
  if (!banner || !message) return null;

  const openAnswer = () => {
    markDelivery(message, 'opened');
    router.push({ pathname: '/chat', params: { focus: message.id } });
  };
  const close = () => {
    markDelivery(message, 'dismissed');
    closeBanner();
  };

  const notice = message.saved ? null : answerNotice(message, t);
  const hits = localOnly ? (message.localHits ?? []) : [];

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
          gap: theme.space[2],
        },
      ]}
    >
      {message.saved ? (
        <AppText numberOfLines={2}>{savedLine}</AppText>
      ) : message.text ? (
        <AppText testID="answer-text" numberOfLines={2}>
          {message.text}
        </AppText>
      ) : null}
      {notice ? (
        <AppText testID="answer-notice" variant={message.text ? 'meta' : 'body'} numberOfLines={2}>
          {notice}
        </AppText>
      ) : null}
      {hits.length > 0 ? (
        <>
          <AppText variant="meta">{t('answer.local_found', { n: hits.length })}</AppText>
          <LocalHitChips messageId={message.id} recordIds={hits} titles={titles} />
        </>
      ) : null}
      {message.sources && message.sources.length > 0 ? (
        <SourceChips messageId={message.id} sources={message.sources} max={2} onMore={openAnswer} />
      ) : null}
      {message.status === 'done' && message.aiGenerated && message.text ? (
        <AppText testID="answer-ai-label" variant="meta" numberOfLines={1}>
          {t('ai.label_short')}
        </AppText>
      ) : null}
      {message.status === 'interrupted' ? (
        <Button testID="answer-retry" label={t('answer.retry')} variant="text" onPress={() => void retry(message.id)} />
      ) : null}
      <View style={[styles.row, { gap: theme.space[2], flexDirection: theme.largeFont ? 'column' : 'row' }]}>
        <Button
          testID="answer-open"
          label={t('answer.open')}
          variant="outline"
          style={theme.largeFont ? undefined : styles.flex}
          onPress={openAnswer}
        />
        <Button
          testID="answer-close"
          label={t('answer.close')}
          variant="text"
          style={theme.largeFont ? undefined : styles.flex}
          onPress={close}
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
