import { router } from 'expo-router';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react-native';
import { AccessibilityInfo, findNodeHandle, Pressable, StyleSheet, View } from 'react-native';

import { useAlarms } from '@/alarms/store';
import { answerProposal, cancelPick, markDelivery, retry } from '@/chat/service';
import { useSavedLine } from '@/store/connectivity';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { useView } from '@/store/view';
import { useTheme } from '@/theme';

import { answerNotice, useLocalHitTitles } from './answerText';
import { AppText } from './AppText';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { pressedStyle } from './ui/motion';
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
      // Design-system §3 AnswerSheet look, compact: raised surface, radius 24, floating shadow, no border.
      backgroundColor: theme.colors.surfaceRaised,
      borderRadius: theme.radius.sheet,
      padding: theme.space[4],
      gap: theme.space[2],
    },
    theme.elevation.floating,
  ];
  const buttonsRow = [styles.row, { gap: theme.space[2], flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const }];

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
  const onlyNotice =
    message.notice === 'offline_action' || message.notice === 'no_ai_action' || message.notice === 'offline_reminder';
  const setByHand = () => {
    const q = useAssistant.getState().messages.find((m) => m.id === message.replyTo);
    const text = q?.text ?? '';
    const phrase = useAlarms.getState().pendingPhrases.find((p) => p.text === text);
    close();
    router.push({ pathname: '/reminder-new', params: { text, ...(phrase ? { phraseId: phrase.id } : {}) } });
  };

  // The usual answer: «Помощник» + ✕ on top, the answer, its sources and the label, «Открыть ответ» as a tonal chip.
  const usual = message.notice !== 'offline_reminder' && !onlyNotice;
  return (
    <View testID="answer-banner" accessibilityLiveRegion="polite" style={box}>
      {usual ? (
        <View style={[styles.head, { gap: theme.space[2] }]}>
          <AppText variant="sectionLabel" style={styles.flex}>
            {t('answer.assistant')}
          </AppText>
          <Pressable
            testID="answer-close"
            accessibilityRole="button"
            accessibilityLabel={t('answer.close')}
            onPress={close}
            style={({ pressed }) => [styles.target, { width: theme.size.minTouch, height: theme.size.minTouch, marginVertical: -theme.space[2], marginRight: -theme.space[2] }, pressedStyle(pressed)]}
          >
            <View style={[styles.target, { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.surfaceSunken }]}>
              <Icon icon={X} size="sm" color="ink2" />
            </View>
          </Pressable>
        </View>
      ) : null}
      {message.saved ? (
        <AppText numberOfLines={2}>{savedLine}</AppText>
      ) : message.text ? (
        <AppText testID="answer-text" numberOfLines={2}>
          {message.text}
        </AppText>
      ) : null}
      {notice ? (
        <AppText testID="answer-notice" variant={message.text ? 'callout' : 'body'} numberOfLines={onlyNotice ? undefined : 2}>
          {notice}
        </AppText>
      ) : null}
      {hits.length > 0 ? (
        <>
          <AppText variant="callout">{t('answer.local_found', { n: hits.length })}</AppText>
          <LocalHitChips messageId={message.id} recordIds={hits} titles={titles} />
        </>
      ) : null}
      {message.sources && message.sources.length > 0 ? (
        <SourceChips messageId={message.id} sources={message.sources} max={2} onMore={openAnswer} />
      ) : null}
      {message.status === 'done' && message.aiGenerated && message.text ? (
        <AppText testID="answer-ai-label" variant="footnote" /* the «ИИ» label is shown whole, never cut (2-design §8) */>
          {t('ai.label_short')}
        </AppText>
      ) : null}
      {message.notice === 'maybe_done' ? (
        <Button testID="answer-did" label={t('more.did')} variant="text" onPress={() => router.push('/did')} style={styles.start} />
      ) : message.status === 'interrupted' ? (
        <Button testID="answer-retry" label={t('answer.retry')} variant="text" onPress={() => void retry(message.id)} style={styles.start} />
      ) : null}
      {message.notice === 'offline_reminder' ? (
        <View style={buttonsRow}>
          <Button testID="answer-set-by-hand" label={t('rem.set_by_hand')} variant="secondary" size="small" onPress={setByHand} />
          <Button testID="answer-ok" label={t('common.ok')} variant="text" onPress={close} />
        </View>
      ) : onlyNotice ? (
        <Button testID="answer-ok" label={t('common.ok')} variant="secondary" size="small" onPress={close} style={styles.start} />
      ) : (
        <View style={buttonsRow}>
          <Button testID="answer-open" label={t('answer.open')} variant="secondary" size="small" onPress={openAnswer} />
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
                variant={isDefault ? 'primary' : o.kind === 'cancel' || o.kind === 'no' ? 'text' : 'secondary'}
                labelColor={p.kind === 'delete' && o.kind === 'yes' && !isDefault ? 'danger' : undefined}
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
  box: {},
  row: {},
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center' },
  target: { alignItems: 'center', justifyContent: 'center' },
  start: { alignSelf: 'flex-start' },
});
