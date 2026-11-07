import { router } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, findNodeHandle, StyleSheet, View } from 'react-native';

import { answerProposal, cancelPick, markDelivery, retry } from '@/chat/service';
import { useSavedLine } from '@/store/connectivity';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { useView } from '@/store/view';
import { useTheme } from '@/theme';

import { answerNotice, useLocalHitTitles } from './answerText';
import { AppText } from './AppText';
import { Button } from './Button';
import { LocalHitChips, SourceChips } from './SourceChips';
import { useCurrentPage } from './useCurrentPage';

/**
 * S08 — answer banner above the assistant line (2-design §4.4 п. 2). Up to 2 lines of the answer,
 * ≤2 source chips + «ещё N», the AI label in one line, [Открыть ответ] [Закрыть]. It does not go
 * away by itself: it stays until «Закрыть» or the next request (R-52). Live region, does not take
 * focus. It shows one message of the conversation, so it follows the stream as it comes.
 *
 * The person went to another page: the banner waits on «Сегодня» (3-engineering 6.11 п. 3).
 * It also asks the assistant's questions back (Proposal): «Какую?» with 2–3 options (US-30),
 * «Переставить 212 записей?» and «Вы сами расставили 4 записи. Переставить и их?» — the default
 * («Оставить мои») first and focused (2-design 6.9).
 */
export function AnswerBanner() {
  const theme = useTheme();
  const { t } = useTranslation();
  const current = useCurrentPage();
  const banner = useAssistant((s) => s.banner);
  const message = useAssistant((s) => (s.banner ? s.messages.find((m) => m.id === s.banner?.messageId) : undefined));
  const closeBanner = useAssistant((s) => s.closeBanner);
  const picking = useView((s) => s.picking);
  const savedLine = useSavedLine();
  // «Нашёл у себя» while nothing else is there yet, and offline.
  const localOnly = !!message && (message.status === 'queued' || (message.status === 'streaming' && !message.text && !message.sources?.length));
  const titles = useLocalHitTitles(localOnly ? message?.localHits : undefined, t);
  if (!banner || !message) return null;
  if (current.kind === 'page' && current.id !== message.pageId) return null;

  const openAnswer = () => {
    markDelivery(message, 'opened');
    router.push({ pathname: '/chat', params: { focus: message.id } });
  };
  const close = () => {
    markDelivery(message, 'dismissed');
    closeBanner();
  };

  const box = [
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
  ];
  const buttonsRow = [styles.row, { gap: theme.space[2], flexDirection: theme.largeFont ? ('column' as const) : ('row' as const), flexWrap: 'wrap' as const }];

  if (picking?.messageId === message.id) {
    return (
      <View testID="answer-banner" accessibilityLiveRegion="polite" style={box}>
        <AppText testID="pick-hint">{t('choice.pick_hint')}</AppText>
        <Button testID="pick-cancel" label={t('choice.cancel')} variant="text" onPress={cancelPick} />
      </View>
    );
  }
  if (message.proposal && !message.proposal.answered) {
    return <ProposalPrompt message={message} box={box} />;
  }

  const notice = message.saved ? null : answerNotice(message, t);
  const hits = localOnly ? (message.localHits ?? []) : [];
  // «Разложить смогу, когда появится интернет» [Хорошо]: nothing to open.
  const onlyNotice = message.notice === 'offline_action' || message.notice === 'no_ai_action';

  return (
    <View testID="answer-banner" accessibilityLiveRegion="polite" style={box}>
      {message.saved ? (
        <AppText numberOfLines={2}>{savedLine}</AppText>
      ) : message.text ? (
        <AppText testID="answer-text" numberOfLines={2}>
          {message.text}
        </AppText>
      ) : null}
      {notice ? (
        <AppText testID="answer-notice" variant={message.text ? 'meta' : 'body'} numberOfLines={onlyNotice ? undefined : 2}>
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
      {onlyNotice ? (
        <Button testID="answer-ok" label={t('common.ok')} variant="outline" onPress={close} />
      ) : (
        <View style={buttonsRow}>
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
      )}
    </View>
  );
}

/**
 * A question back. The default option (`keep_mine` for records placed by hand) comes first and gets
 * the screen reader's focus; nothing the person placed moves without their «Да» (R-54).
 */
function ProposalPrompt({ message, box }: { message: ChatMessage; box: object[] }) {
  const theme = useTheme();
  const defaultRef = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => {
    const node = defaultRef.current ? findNodeHandle(defaultRef.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, []);
  const p = message.proposal;
  if (!p) return null;
  const options = [...p.options].sort((a, b) => Number(b.id === p.defaultId) - Number(a.id === p.defaultId));
  return (
    <View testID="answer-banner" accessibilityLiveRegion="polite" style={box}>
      <AppText testID="proposal-text">{p.question}</AppText>
      <View style={[styles.row, { gap: theme.space[2], flexDirection: theme.largeFont ? 'column' : 'row', flexWrap: 'wrap' }]}>
        {options.map((o) => {
          const isDefault = o.id === p.defaultId;
          return (
            <View key={o.id} ref={isDefault ? defaultRef : undefined}>
              <Button
                testID={`proposal-${o.id}`}
                label={o.label}
                variant={isDefault ? 'primary' : o.kind === 'cancel' || o.kind === 'no' ? 'text' : 'outline'}
                onPress={() => void answerProposal(message.id, o.id)}
              />
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1 },
  row: {},
  flex: { flex: 1 },
});
