import { router, useLocalSearchParams } from 'expo-router';
import { AiLabel } from '@/components/AiLabel';
import { Flag, Search } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, findNodeHandle, ScrollView, StyleSheet, View } from 'react-native';

import type { ActionOut } from '@/api/types';
import { actionText, canReport, loadHistory, loadServerHistory, retry, undoAction } from '@/chat/service';
import { AppText } from '@/components/AppText';
import { answerNotice } from '@/components/answerText';
import { FeedbackSheet } from '@/components/FeedbackSheet';
import { Screen } from '@/components/Screen';
import { SourceChips } from '@/components/SourceChips';
import { Button } from '@/components/ui/Button';
import { cardEdge } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Header } from '@/components/ui/Header';
import { ActionList, Sheet } from '@/components/ui/Sheet';
import { getApi, syncBlocked } from '@/services';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { useOnboarding } from '@/store/onboarding';
import { useToast } from '@/store/toast';
import { undoOf, undoServerAction } from '@/tasks/actions';
import { rememberActions } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { useTheme } from '@/theme';
import { historyEntries, matchesFilter, type HistoryEntry, type HistoryFilter } from '@/chat/history';

const DAY = 86_400_000;
type Status = 'done' | 'waiting' | 'undone' | null;

/**
 * «История» (S36 + S20, Ф-50): «что вы сказали → что я сделал». Filter chips Всё · Изменения · Вопросы · Ждут; days
 * as headers; each item: the time · a dot (brand — done, sun — waits, grey — undone) · «Вы: «…»» · a card with
 * what was done, a badge Сделано / Ждёт / Отменено, the page and «помощник», and its action: «Отменить»,
 * «Ответить» or «Вернуть». Opened on an answer (`focus`), it scrolls there. The line and the tabs stay below.
 */
export default function HistoryScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { focus, tab } = useLocalSearchParams<{ focus?: string; tab?: string }>();
  const messages = useAssistant((s) => s.messages);
  const actions = useTasks((s) => s.actions);
  const showToast = useToast((s) => s.show);
  const [filter, setFilter] = useState<HistoryFilter>(tab === 'changes' ? 'changes' : 'all');
  const [busy, setBusy] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null);
  const [reportFor, setReportFor] = useState<ChatMessage | null>(null);
  const [now] = useState(() => Date.now());
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const focusRef = useRef<React.ComponentRef<typeof View>>(null);
  const [focusY, setFocusY] = useState<number | null>(null);

  useEffect(() => {
    void loadServerHistory().then((ok) => {
      if (ok) return;
      void loadHistory();
      if (useOnboarding.getState().consent === null || syncBlocked()) return;
      void getApi()
        .actions({ limit: 100 })
        .then((out) => rememberActions(out.actions))
        .catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    if (focusY === null) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, focusY - 16), animated: false });
    const node = focusRef.current ? findNodeHandle(focusRef.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [focusY]);

  const all = useMemo(() => historyEntries(messages, actions), [messages, actions]);
  const shown = all.filter((e) => matchesFilter(e, filter));

  const time = (ms: number) => {
    try {
      return new Date(ms).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return new Date(ms).toISOString().slice(11, 16);
    }
  };
  const dayTitle = (ms: number) => {
    const d = new Date(ms).toDateString();
    if (d === new Date(now).toDateString()) return t('history.today');
    if (d === new Date(now - DAY).toDateString()) return t('history.yesterday');
    try {
      return new Date(ms).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' });
    } catch {
      return d;
    }
  };

  const runUndo = async (a: ActionOut) => {
    setBusy(a.id);
    const r = await undoServerAction(a.id);
    setBusy(null);
    if (r.result === 'expired') showToast(t('changes.expired'), 4000);
    else if (r.result === 'failed') showToast(t('errors.generic'), 4000);
    else if (r.result === 'queued') showToast(t('did.queued'), 4000);
    else if (r.message) showToast(r.message, 4000);
  };

  const back = () => {
    const banner = useAssistant.getState().banner;
    if (focus && banner?.messageId === focus) useAssistant.getState().closeBanner();
    if (router.canGoBack()) router.back();
    else router.replace('/more');
  };
  const chips: { key: HistoryFilter; label: string }[] = [
    { key: 'all', label: t('history.all') },
    { key: 'changes', label: t('history.changes') },
    { key: 'questions', label: t('history.questions') },
    { key: 'waiting', label: t('history.waiting') },
  ];

  const days = shown.map((e) => dayTitle(e.at));
  return (
    <Screen testID="history-screen" edges={['top']} scroll={false}>
      <ScrollView ref={scrollRef} testID="chat-screen" contentContainerStyle={{ paddingTop: theme.space[4], paddingBottom: theme.size.contentEndGap, gap: theme.space[3] }} keyboardShouldPersistTaps="handled">
        <Header
          title={t('history.title')}
          meta={t('history.meta')}
          back={{ onPress: back, label: t('more.title'), testID: 'chat-collapse' }}
          actions={[{ key: 'search', icon: Search, label: t('today.search'), onPress: () => router.navigate('/search'), testID: 'history-search' }]}
        />
        <View accessibilityRole="tablist" style={[styles.chips, { gap: theme.space[2] }]}>
          {chips.map((c) => (
            <Chip
              key={c.key}
              testID={`history-filter-${c.key}`}
              label={c.label}
              variant={filter === c.key ? 'selected' : 'neutral'}
              onPress={() => setFilter(c.key)}
            />
          ))}
        </View>
        {shown.length === 0 ? (
          <AppText testID="did-empty" color="ink2">
            {filter === 'all' ? t('chat.empty') : t('history.none')}
          </AppText>
        ) : null}
        {shown.map((e, i) => {
          const day = days[i]!;
          const header = i === 0 || days[i - 1] !== day;
          const focused = !!focus && e.answer?.id === focus;
          return (
            <View key={e.key} testID={e.answer ? `chat-msg-${e.answer.id}` : `did-${e.action?.id}`} onLayout={focused ? (ev) => setFocusY(ev.nativeEvent.layout.y) : undefined}>
              {header ? (
                <AppText variant="eyebrow" color="ink2" accessibilityRole="header" style={{ marginTop: theme.space[2], marginBottom: theme.space[2] }}>
                  {day}
                </AppText>
              ) : null}
              <View ref={focused ? focusRef : undefined} accessible={focused || undefined}>
                <HistoryItem
                  entry={e}
                  time={time(e.at)}
                  busy={busy}
                  onUndo={runUndo}
                  onMore={(m) => setMenuFor(m)}
                  recent={!e.action?.created_at || Date.parse(e.action.created_at) > now - 30 * DAY}
                />
              </View>
            </View>
          );
        })}
      </ScrollView>

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
    </Screen>
  );
}

/** HistoryItem (design-system v2 §5): time · dot · «Вы: «…»» · the card of what was done. */
function HistoryItem({
  entry,
  time,
  busy,
  recent,
  onUndo,
  onMore,
}: {
  entry: HistoryEntry;
  time: string;
  busy: string | null;
  recent: boolean;
  onUndo: (a: ActionOut) => void;
  onMore: (m: ChatMessage) => void;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const m = entry.answer;
  const a = entry.action;
  const chatAction = m?.action;
  const undone = !!a?.undone_at || !!chatAction?.undone;
  const status: Status = entry.kind === 'waiting' ? 'waiting' : undone ? 'undone' : entry.kind === 'change' ? 'done' : null;
  const dot = status === 'waiting' ? theme.colors.highlight : status === 'undone' ? theme.colors.iconSecondary : theme.colors.brand;
  const title = a
    ? (i18n.language === 'kk' && a.summary.kk) || a.summary.ru
    : chatAction
      ? actionText(chatAction, i18n.language)
      : m?.proposal && !m.proposal.answered
        ? m.proposal.question
        : m?.saved
          ? t('line.saved')
          : (m?.text ?? '');
  const notice = m && !m.saved && !chatAction ? answerNotice(m, t) : null;
  const pageTitle = a?.page?.title ?? chatAction?.pageTitle ?? null;
  const who = a?.initiated_by === 'user' && !m ? t('did.by_you') : t('history.assistant');
  const meta = [pageTitle, who].filter(Boolean).join(' · ');
  const back = a?.undone_at ? undoOf(a.id) : undefined;
  const canUndo = recent && ((a ? a.undoable && !a.undone_at : !!chatAction?.undoable && !chatAction.undone));
  const badge =
    status === 'done' ? { text: t('history.badge_done'), bg: theme.colors.brandTint, fg: theme.colors.brand } : status === 'waiting' ? { text: t('history.badge_waiting'), bg: theme.colors.highlight, fg: theme.colors.onHighlight } : status === 'undone' ? { text: t('history.badge_undone'), bg: theme.colors.surfaceSunken, fg: theme.colors.ink2 } : null;

  return (
    <View style={{ gap: theme.space[2] }}>
      <View style={[styles.row, { gap: theme.space[2] }]}>
        <AppText variant="callout" style={{ minWidth: 44, fontFamily: theme.type.button.fontFamily, fontVariant: ['tabular-nums'] }}>
          {time}
        </AppText>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dot }} />
        <AppText variant="callout" color="ink2" style={styles.flex} numberOfLines={2}>
          {entry.said ? t('history.you_said', { text: entry.said }) : t('history.by_hand')}
        </AppText>
      </View>
      <View
        style={[
          { marginLeft: 54, backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: theme.space[3], gap: theme.space[1] },
          theme.elevation.card,
          cardEdge(theme),
        ]}
      >
        <View style={[styles.row, { gap: theme.space[2], alignItems: 'flex-start' }]}>
          <AppText
            testID={m && (chatAction || m.saved) ? `chat-action-${m.id}` : undefined}
            variant={entry.kind === 'question' ? 'body' : 'headline'}
            style={[styles.flex, undone ? styles.struck : null]}
          >
            {undone && chatAction ? t('chat.action_undone', { text: title }) : title}
          </AppText>
          {badge ? (
            <View style={{ backgroundColor: badge.bg, borderRadius: theme.radius.round, paddingHorizontal: theme.space[2], paddingVertical: 2 }}>
              <AppText variant="caption" style={{ color: badge.fg, fontFamily: theme.type.button.fontFamily }}>
                {badge.text}
              </AppText>
            </View>
          ) : null}
        </View>
        {notice ? <AppText variant="callout">{notice}</AppText> : null}
        {m?.sources && m.sources.length > 0 ? <SourceChips messageId={m.id} sources={m.sources} /> : null}
        {m && m.status === 'done' && m.aiGenerated && !!m.text && !chatAction ? <AiLabel variant="footnote" /> : null}
        <View style={[styles.row, { gap: theme.space[2], flexWrap: 'wrap' }]}>
          {meta && entry.kind !== 'question' ? (
            <AppText variant="footnote" style={styles.flex}>
              {meta}
            </AppText>
          ) : (
            <View style={styles.flex} />
          )}
          {canUndo ? (
            <Button
              testID={m && chatAction ? `chat-undo-${m.id}` : `did-undo-${a?.id}`}
              label={t('common.undo')}
              accessibilityLabel={t('did.undo_a11y', { what: title })}
              variant="text"
              disabled={!!a && busy === a.id}
              onPress={() => (m && chatAction && !a ? void undoAction(m.id) : a ? onUndo(a) : undefined)}
            />
          ) : null}
          {back && recent ? (
            <Button testID={`did-redo-${a?.id}`} label={t('changes.revert')} accessibilityLabel={t('did.redo_a11y', { what: title })} variant="text" disabled={busy === back.id} onPress={() => onUndo(back)} />
          ) : null}
          {entry.kind === 'waiting' && m?.proposal ? (
            <Button
              testID={`history-answer-${m.id}`}
              label={t('history.answer')}
              variant="text"
              onPress={() => {
                useAssistant.getState().showBanner({ messageId: m.id });
                router.navigate('/');
              }}
            />
          ) : null}
          {m?.status === 'interrupted' ? <Button testID={`chat-retry-${m.id}`} label={t('answer.retry')} variant="text" onPress={() => void retry(m.id)} /> : null}
          {m && canReport(m) && m.status !== 'streaming' ? <Button testID={`chat-more-${m.id}`} label={t('chat.more')} variant="text" onPress={() => onMore(m)} /> : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
  struck: { textDecorationLine: 'line-through' },
});
