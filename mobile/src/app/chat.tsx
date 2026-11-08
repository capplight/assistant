import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AccessibilityInfo,
  findNodeHandle,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/AppText';
import { answerNotice, useLocalHitTitles } from '@/components/answerText';
import { AssistantLine } from '@/components/AssistantLine';
import { Button } from '@/components/Button';
import { FeedbackSheet } from '@/components/FeedbackSheet';
import { LocalHitChips, SourceChips } from '@/components/SourceChips';
import { actionText, canReport, loadHistory, retry, undoAction } from '@/chat/service';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { useTheme } from '@/theme';

/**
 * S36 «Переписка» — one conversation for all pages (R-52), full screen, «Свернуть» on top, the same
 * assistant line at the bottom (over all pages). Dividers «— на странице X, 14:20 —» are headers.
 * Opened from the banner («Открыть ответ», `focus`), it is scrolled to that answer and the screen
 * reader starts there. History is kept on the phone and completed from the server when online.
 * Actions show as their line «Разложил 23 заметки» with [Отменить] while it can be undone (2-design
 * 4.4 п. 4). Not yet: «Озвучить» (needs a speech module), «Не то» (one re-ask on the server).
 */
export default function ChatScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const messages = useAssistant((s) => s.messages);
  const bannerId = useAssistant((s) => s.banner?.messageId);
  const closeBanner = useAssistant((s) => s.closeBanner);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const focusRef = useRef<React.ComponentRef<typeof View>>(null);
  const [focusY, setFocusY] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null);
  const [reportFor, setReportFor] = useState<ChatMessage | null>(null);

  useEffect(() => {
    void loadHistory();
  }, []);

  useEffect(() => {
    if (focusY === null) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, focusY - 16), animated: false });
    const node = focusRef.current ? findNodeHandle(focusRef.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [focusY]);

  const time = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso.slice(11, 16);
    }
  };

  const collapse = () => {
    // Back to the same page; the banner of the answer just read is closed (2-design S08).
    if (focus && bannerId === focus) closeBanner();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <SafeAreaView
      testID="chat-screen"
      style={[styles.root, { backgroundColor: theme.colors.bg }]}
      edges={['top', 'bottom']}
    >
      <View style={[styles.header, { paddingHorizontal: theme.screenPadding, borderBottomColor: theme.colors.line }]}>
        <AppText variant="title1" accessibilityRole="header" style={styles.flex}>
          {t('chat.title')}
        </AppText>
        <Button
          testID="chat-collapse"
          variant="text"
          minHeight={theme.size.minTouch}
          label={t('chat.collapse')}
          onPress={collapse}
        />
      </View>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView ref={scrollRef} contentContainerStyle={{ padding: theme.screenPadding, gap: theme.space[3] }}>
          {messages.length === 0 ? <AppText color="ink2">{t('chat.empty')}</AppText> : null}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const divider = !prev || prev.pageId !== m.pageId;
            const focused = m.id === focus;
            return (
              <View
                key={m.id}
                testID={`chat-msg-${m.id}`}
                style={{ gap: theme.space[2] }}
                onLayout={focused ? (e) => setFocusY(e.nativeEvent.layout.y) : undefined}
              >
                {divider ? (
                  <AppText variant="meta" accessibilityRole="header" style={styles.center}>
                    {t('chat.divider', { page: m.pageTitle, time: time(m.at) })}
                  </AppText>
                ) : null}
                {m.role === 'user' ? (
                  <AppText variant="meta" color="ink">
                    {t('chat.you', { text: m.text })}
                  </AppText>
                ) : (
                  <View ref={focused ? focusRef : undefined} accessible={focused} style={{ gap: theme.space[2] }}>
                    <Answer m={m} onMore={() => setMenuFor(m)} />
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
        <AssistantLine scope="all" />
      </KeyboardAvoidingView>

      <Modal visible={menuFor !== null} transparent animationType="slide" onRequestClose={() => setMenuFor(null)}>
        <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
          <SafeAreaView
            edges={['bottom']}
            testID="answer-menu"
            style={{
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.sheet,
              borderTopRightRadius: theme.radius.sheet,
              padding: theme.space[5],
              gap: theme.space[2],
            }}
          >
            <Button
              testID="answer-report"
              label={t('feedback.open')}
              variant="outline"
              onPress={() => {
                setReportFor(menuFor);
                setMenuFor(null);
              }}
            />
            <Button label={t('common.close')} variant="text" onPress={() => setMenuFor(null)} />
          </SafeAreaView>
        </View>
      </Modal>
      <FeedbackSheet message={reportFor} onClose={() => setReportFor(null)} />
    </SafeAreaView>
  );
}

/** A whole answer: text, what is happening with it, sources, the AI label, «Ещё». */
function Answer({ m, onMore }: { m: ChatMessage; onMore: () => void }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const titles = useLocalHitTitles(m.status === 'queued' ? m.localHits : undefined, t);
  const notice = m.saved ? null : answerNotice(m, t);
  const hits = m.status === 'queued' ? (m.localHits ?? []) : [];
  const generated = m.status === 'done' && m.aiGenerated && !!m.text;
  const action = m.action;
  return (
    <>
      {m.text && !action ? <AppText>{m.text}</AppText> : null}
      {action ? (
        <View style={[styles.actionRow, { gap: theme.space[2] }]}>
          <AppText testID={`chat-action-${m.id}`} style={styles.flex}>
            {action.undone
              ? t('chat.action_undone', { text: actionText(action, i18n.language) })
              : actionText(action, i18n.language)}
          </AppText>
          {action.undoable && !action.undone ? (
            <Button testID={`chat-undo-${m.id}`} label={t('common.undo')} variant="text" onPress={() => void undoAction(m.id)} />
          ) : null}
        </View>
      ) : null}
      {m.proposal ? <AppText variant="meta">{m.proposal.question}</AppText> : null}
      {notice ? <AppText variant={m.text ? 'meta' : 'body'}>{notice}</AppText> : null}
      {hits.length > 0 ? (
        <>
          <AppText variant="meta">{t('answer.local_found', { n: hits.length })}</AppText>
          <LocalHitChips messageId={m.id} recordIds={hits} titles={titles} />
        </>
      ) : null}
      {m.sources && m.sources.length > 0 ? <SourceChips messageId={m.id} sources={m.sources} /> : null}
      {generated ? <AppText variant="meta">{t('ai.label')}</AppText> : null}
      {m.notice === 'maybe_done' ? (
        <Button testID={`chat-did-${m.id}`} label={t('more.did')} variant="text" onPress={() => router.push('/did')} />
      ) : m.status === 'interrupted' ? (
        <Button testID={`chat-retry-${m.id}`} label={t('answer.retry')} variant="text" onPress={() => void retry(m.id)} />
      ) : null}
      {canReport(m) && m.status !== 'streaming' ? (
        <View style={[styles.actions, { gap: theme.space[2] }]}>
          <Button testID={`chat-more-${m.id}`} label={t('chat.more')} variant="text" onPress={onMore} />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1 },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
  actionRow: { flexDirection: 'row', alignItems: 'center' },
});
