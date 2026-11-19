import { router, useLocalSearchParams } from 'expo-router';
import { clockOf } from '@/alarms/format';
import { AiLabel } from '@/components/AiLabel';
import { Flag } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, findNodeHandle, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { ActionOut } from '@/api/types';
import { actionText, canReport, loadHistory, loadServerHistory, retry, undoAction } from '@/chat/service';
import { AppText } from '@/components/AppText';
import { answerNotice } from '@/components/answerText';
import { FeedbackSheet } from '@/components/FeedbackSheet';
import { Screen } from '@/components/Screen';
import { ChipRow, PlaceTab, SectionHead } from '@/components/ui/Leaf';
import { SourceChips } from '@/components/SourceChips';
import { Button } from '@/components/ui/Button';
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
import { placeOfTemplate, useTheme, type PlaceKey } from '@/theme';
import { usePages } from '@/store/pages';
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
      return clockOf(new Date(ms).toISOString());
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
    // v5: «История» is the assistant's journal — the terracotta sheet; only the title and «‹ Ещё» on it (no small text).
    <Screen testID="history-screen" place="assistant" scrollRef={scrollRef}>
      <Header title={t('history.title')} back={{ onPress: back, label: t('more.title'), testID: 'chat-collapse' }} />
      <View testID="chat-screen">
        <AppText variant="small">{t('history.meta')}</AppText>
        <ChipRow style={{ marginTop: 12, marginBottom: 4 }}>
          {chips.map((c) => (
            <Chip
              key={c.key}
              testID={`history-filter-${c.key}`}
              label={c.label}
              variant={filter === c.key ? 'selected' : 'neutral'}
              onPress={() => setFilter(c.key)}
            />
          ))}
        </ChipRow>
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
            <View
              key={e.key}
              testID={e.answer ? `chat-msg-${e.answer.id}` : `did-${e.action?.id}`}
              onLayout={focused ? (ev) => setFocusY(ev.nativeEvent.layout.y) : undefined}
            >
              {header ? <SectionHead first={i === 0} title={day} /> : null}
              <View ref={focused ? focusRef : undefined} accessible={focused || undefined}>
                <HistoryItem
                  first={header}
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
      </View>

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
  first,
}: {
  first?: boolean;
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
  const status: Status =
    entry.kind === 'waiting' ? 'waiting' : undone ? 'undone' : entry.kind === 'change' ? 'done' : null;
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
  const canUndo = recent && (a ? a.undoable && !a.undone_at : !!chatAction?.undoable && !chatAction.undone);
  const pages = usePages((st) => st.pages);
  const serverPage = a?.page?.id ?? chatAction?.pageServerId ?? null;
  const page = serverPage ? pages.find((p) => p.serverId === serverPage) : undefined;
  const place: PlaceKey = entry.kind === 'question' ? 'assistant' : page ? placeOfTemplate(page.templateKey) : 'stone';
  const state = status === 'waiting' ? t('history.st_waiting') : undone ? t('history.st_undone') : null;
  const said = entry.said ? t('history.you_said', { text: entry.said }) : t('history.by_hand');
  const shownTitle = undone && chatAction ? t('chat.action_undone', { text: title }) : title;

  return (
    <View style={{ paddingVertical: 10, borderTopWidth: first ? 0 : 1, borderTopColor: theme.colors.line }}>
      <AppText variant="footnote" numberOfLines={2}>
        <AppText variant="footnote" style={{ fontVariant: ['tabular-nums'] }}>
          {time}
        </AppText>
        {' · '}
        <AppText variant="footnote">{said}</AppText>
      </AppText>
      <View style={[styles.row, { gap: 12, marginTop: 6 }]}>
        <PlaceTab place={place} />
        <View style={styles.flex}>
          <AppText
            testID={m && (chatAction || m.saved) ? `chat-action-${m.id}` : undefined}
            numberOfLines={entry.kind === 'question' ? 3 : 2}
            style={[
              { fontFamily: entry.kind === 'question' ? theme.type.row.fontFamily : theme.type.bodyStrong.fontFamily },
              undone ? styles.struck : null,
            ]}
          >
            {shownTitle}
          </AppText>
          {state ? (
            <AppText testID={`history-state-${entry.key}`} variant="footnote">
              {state}
            </AppText>
          ) : meta && entry.kind !== 'question' ? (
            <AppText variant="footnote" numberOfLines={1}>
              {meta}
            </AppText>
          ) : null}
        </View>
        {canUndo ? (
          <Pressable
            testID={m && chatAction ? `chat-undo-${m.id}` : `did-undo-${a?.id}`}
            accessibilityRole="button"
            accessibilityLabel={t('did.undo_a11y', { what: title })}
            disabled={!!a && busy === a.id}
            hitSlop={8}
            onPress={() => (m && chatAction && !a ? void undoAction(m.id) : a ? onUndo(a) : undefined)}
            style={({ pressed }) => [styles.link, pressed ? { opacity: 0.6 } : null]}
          >
            <AppText
              nativeID="v5-one-line"
              numberOfLines={1}
              style={{
                color: theme.colors.assistantText,
                fontFamily: theme.type.headline.fontFamily,
                fontSize: 15,
                lineHeight: 18,
              }}
            >
              {t('common.undo')}
            </AppText>
          </Pressable>
        ) : back && recent ? (
          <Pressable
            testID={`did-redo-${a?.id}`}
            accessibilityRole="button"
            accessibilityLabel={t('did.redo_a11y', { what: title })}
            disabled={busy === back.id}
            hitSlop={8}
            onPress={() => onUndo(back)}
            style={({ pressed }) => [styles.link, pressed ? { opacity: 0.6 } : null]}
          >
            <AppText
              nativeID="v5-one-line"
              numberOfLines={1}
              style={{
                fontFamily: theme.type.headline.fontFamily,
                fontSize: 15,
                lineHeight: 18,
                textDecorationLine: 'underline',
              }}
            >
              {t('changes.revert')}
            </AppText>
          </Pressable>
        ) : entry.kind === 'waiting' && m?.proposal ? (
          <Button
            testID={`history-answer-${m.id}`}
            label={t('history.answer')}
            size="small"
            minHeight={38}
            onPress={() => {
              useAssistant.getState().showBanner({ messageId: m.id });
              router.navigate('/');
            }}
          />
        ) : null}
      </View>
      {notice ? (
        <AppText variant="small" style={{ marginTop: 6, marginLeft: 28 }}>
          {notice}
        </AppText>
      ) : null}
      {m?.sources && m.sources.length > 0 ? (
        <View style={{ marginTop: 6, marginLeft: 28 }}>
          <SourceChips messageId={m.id} sources={m.sources} />
        </View>
      ) : null}
      {m && m.status === 'done' && m.aiGenerated && !!m.text && !chatAction ? (
        <AiLabel variant="footnote" style={{ marginLeft: 28, marginTop: 4 }} />
      ) : null}
      {m && m.status !== 'streaming' && (m.status === 'interrupted' || canReport(m)) ? (
        <View style={[styles.row, { gap: 4, marginLeft: 20 }]}>
          {m.status === 'interrupted' ? (
            <Button
              testID={`chat-retry-${m.id}`}
              label={t('answer.retry')}
              variant="link"
              size="small"
              onPress={() => void retry(m.id)}
            />
          ) : null}
          {canReport(m) ? (
            <Button
              testID={`chat-more-${m.id}`}
              label={t('chat.more')}
              variant="link"
              size="small"
              onPress={() => onMore(m)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
  link: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 4 },
  struck: { textDecorationLine: 'line-through' },
});
