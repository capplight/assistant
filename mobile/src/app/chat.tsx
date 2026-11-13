import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Flag } from 'lucide-react-native';
import { AccessibilityInfo, findNodeHandle, KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/AppText';
import { answerNotice, useLocalHitTitles } from '@/components/answerText';
import { AssistantLine } from '@/components/AssistantLine';
import { ToastLine, useToastAnchor } from '@/components/Toast';
import { KEYBOARD_BEHAVIOR, useKeyboardHeight } from '@/components/useKeyboard';
import { Button } from '@/components/ui/Button';
import { Header } from '@/components/ui/Header';
import { ActionList, Sheet } from '@/components/ui/Sheet';
import { FeedbackSheet } from '@/components/FeedbackSheet';
import { LocalHitChips, SourceChips } from '@/components/SourceChips';
import { actionText, canReport, loadHistory, retry, undoAction } from '@/chat/service';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { useTheme } from '@/theme';

/**
 * S36 «Переписка» — one conversation for all pages (R-52), full screen, `Header` with «‹ Свернуть»; what you said
 * is a `brandTint` bubble on the right, the answer is text without a bubble (design-system §3 AnswerSheet); the same
 * assistant line at the bottom (over all pages). Dividers «— на странице X, 14:20 —» are headers.
 * Opened from the banner («Открыть ответ», `focus`), it is scrolled to that answer and the screen
 * reader starts there. History is kept on the phone and completed from the server when online.
 * Actions show as their line «Разложил 23 заметки» with [Отменить] while it can be undone (2-design
 * 4.4 п. 4). Not yet: «Озвучить» (needs a speech module), «Не то» (one re-ask on the server).
 */
export default function ChatScreen() {
  const theme = useTheme();
  useToastAnchor();
  const keyboard = useKeyboardHeight();
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
      <View style={{ paddingHorizontal: theme.screenPadding }}>
        <View style={[styles.column, { maxWidth: theme.size.maxContentWidth }]}>
          <Header title={t('chat.title')} back={{ onPress: collapse, label: t('chat.collapse'), testID: 'chat-collapse' }} />
        </View>
      </View>
      <KeyboardAvoidingView style={styles.root} behavior={KEYBOARD_BEHAVIOR}>
        <ScrollView ref={scrollRef} contentContainerStyle={{ padding: theme.screenPadding, gap: theme.space[4], width: '100%', maxWidth: theme.size.maxContentWidth, alignSelf: 'center' }}>
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
                  <AppText variant="footnote" accessibilityRole="header" style={styles.center}>
                    {t('chat.divider', { page: m.pageTitle, time: time(m.at) })}
                  </AppText>
                ) : null}
                {m.role === 'user' ? (
                  <View
                    accessible
                    accessibilityLabel={t('chat.you', { text: m.text })}
                    style={[
                      styles.bubble,
                      {
                        backgroundColor: theme.colors.brandTint,
                        paddingHorizontal: theme.space[3],
                        paddingVertical: theme.space[2],
                        borderRadius: theme.radius.lg,
                        borderBottomRightRadius: theme.radius.xs,
                      },
                    ]}
                  >
                    <AppText color="ink">{m.text}</AppText>
                  </View>
                ) : (
                  <View ref={focused ? focusRef : undefined} accessible={focused} style={{ gap: theme.space[2] }}>
                    <Answer m={m} onMore={() => setMenuFor(m)} />
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
        <ToastLine style={{ marginHorizontal: theme.size.tabBarInset, marginBottom: theme.space[2] }} />
        <AssistantLine scope="all" keyboardHeight={keyboard} />
      </KeyboardAvoidingView>

      <Sheet testID="answer-menu" visible={menuFor !== null} onClose={() => setMenuFor(null)}>
        <ActionList
          actions={[
            {
              key: 'report',
              testID: 'answer-report',
              icon: Flag,
              label: t('feedback.open'),
              onPress: () => {
                setReportFor(menuFor);
                setMenuFor(null);
              },
            },
          ]}
        />
      </Sheet>
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
          <View style={[styles.done, { width: 20, height: 20, borderRadius: 10, backgroundColor: action.undone ? theme.colors.iconSecondary : theme.colors.brand }]}>
            <Check size={14} color={theme.colors.onBrand} strokeWidth={2.5} />
          </View>
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
      {m.proposal ? <AppText variant="callout">{m.proposal.question}</AppText> : null}
      {notice ? <AppText variant={m.text ? 'callout' : 'body'}>{notice}</AppText> : null}
      {hits.length > 0 ? (
        <>
          <AppText variant="callout">{t('answer.local_found', { n: hits.length })}</AppText>
          <LocalHitChips messageId={m.id} recordIds={hits} titles={titles} />
        </>
      ) : null}
      {m.sources && m.sources.length > 0 ? <SourceChips messageId={m.id} sources={m.sources} /> : null}
      {generated ? <AppText variant="footnote">{t('ai.label')}</AppText> : null}
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
  column: { width: '100%', alignSelf: 'center' },
  bubble: { alignSelf: 'flex-end', maxWidth: '85%' },
  done: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
  actionRow: { flexDirection: 'row', alignItems: 'center' },
});
