import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { CloudOff, History, Search } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

import { loadHistory, loadServerHistory } from '@/chat/service';
import { AssistantMessage, ChatEmpty, DaySeparator, OfflineBanner, UserBubble } from '@/components/chat/ChatParts';
import { PlaceScreen, SheetIcon } from '@/components/ui/PlaceScreen';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { useConnectivity } from '@/store/connectivity';
import { useTheme } from '@/theme';

const DAY = 86_400_000;

/**
 * «Помощник» — the centre tab (VISION-2026-11, v4 «Чат — центр»): one conversation for the whole app. The header —
 * the glowing mark, «Помощник», «помню 412 записей» / «слушаю…» / «нет связи» / «новый разговор», 🔍 and «История».
 * Messages: yours on the right (from the line of another tab — «с вкладки «Заметки»»), answers on the left with
 * their sources, results of changes as cards («Сделал 3 дела · Переложить · Отменить всё»). A new conversation shows
 * the tagline and four examples. The line below (MainFooter) writes into this same conversation.
 *
 * QA v5-device-3 J4 / L3: an inverted, virtualised list — it opens AT the last message (no jump from the first one,
 * no `scrollToEnd` after the first frame, no 186 ms frame of every message at once) and keeps the strip's room
 * (`listBottomPadding` + 22) under the last one. Back on the tab after a sheet or a modal it goes back to the end if
 * the person was there.
 */
type ChatRow = { m: ChatMessage; day: string; header: boolean };
/** The conversation, newest first (the inverted list's order); a day header goes over the first message of its day. */
export function chatRows(list: ChatMessage[], dayOf: (iso: string) => string): ChatRow[] {
  const days = list.map((m) => dayOf(m.at));
  const rows = list.map((m, i) => ({ m, day: days[i]!, header: i === 0 || days[i - 1] !== days[i] }));
  return rows.reverse();
}
/** Within this many dp of the newest message the person counts as «at the end». */
const AT_END = 48;
export default function AssistantScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const messages = useAssistant((s) => s.messages);
  const online = useConnectivity((s) => s.online);
  // «Помощник · голос»: while it listens the paper holds only the voice view (in the field below).
  const listening = useAssistant((s) => s.listening);
  const listRef = useRef<FlatList<ChatRow>>(null);
  const atEnd = useRef(true);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    void loadServerHistory().then((ok) => {
      if (!ok) void loadHistory();
    });
  }, []);

  // Back on the tab (a sheet, a modal, another tab): at the end again if the person was there.
  useFocusEffect(
    useCallback(() => {
      if (atEnd.current) listRef.current?.scrollToOffset({ offset: 0, animated: false });
    }, []),
  );

  const dayTitle = useCallback(
    (iso: string) => {
      const ms = new Date(iso).getTime();
      const d = new Date(ms).toDateString();
      if (d === new Date(now).toDateString()) return t('history.today');
      if (d === new Date(now - DAY).toDateString()) return t('history.yesterday');
      try {
        return new Date(ms).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' });
      } catch {
        return d;
      }
    },
    [now, t, i18n.language],
  );

  // QA v5-device-1 «Помощник» 1: actions stand only under their answer — the head of a trimmed conversation (a result
  // whose question is no longer here: «Переложить · Отменить» with nothing above) is not shown; it stays in «История».
  const rows = useMemo(() => {
    let start = 0;
    while (start < messages.length && messages[start]!.role !== 'user' && !!messages[start]!.action) start += 1;
    return chatRows(start > 0 ? messages.slice(start) : messages, dayTitle);
  }, [messages, dayTitle]);

  // A message asked for (`?focus=`, from «История»): shown in the middle of the paper.
  const focusIndex = focus ? rows.findIndex((r) => r.m.id === focus) : -1;
  useEffect(() => {
    if (focusIndex < 0) return;
    atEnd.current = false;
    listRef.current?.scrollToIndex({ index: focusIndex, animated: false, viewPosition: 0.5 });
  }, [focusIndex]);

  const renderItem: ListRenderItem<ChatRow> = useCallback(
    ({ item }) => (
      <View style={{ gap: theme.space[3], paddingTop: theme.space[3] }}>
        {item.header ? <DaySeparator label={item.day} /> : null}
        {item.m.role === 'user' ? (
          <UserBubble m={item.m} testID={`chat-user-${item.m.id}`} />
        ) : (
          <AssistantMessage m={item.m} testID={`chat-msg-${item.m.id}`} />
        )}
      </View>
    ),
    [theme],
  );
  const pad = theme.m.gutter;
  const bottomRoom = theme.m.ask.listBottomPadding + 22;
  const ink = theme.colors.onSheet;
  return (
    <PlaceScreen
      testID="assistant-screen"
      place="assistant"
      mode="strip"
      peek={['today', 'notes']}
      title={t('tabs.assistant')}
      scroll={false}
      // The list is the paper's whole height (it scrolls under the strip's corners, as the paper did).
      contentContainerStyle={{ paddingTop: 0, paddingHorizontal: 0 }}
      stripLeft={
        <SheetIcon
          icon={History}
          label={t('more.history')}
          onPress={() => router.push('/history')}
          color={ink}
          testID="assistant-history"
        />
      }
      stripRight={
        online ? (
          <SheetIcon
            icon={Search}
            label={t('today.search')}
            onPress={() => router.navigate('/search')}
            color={ink}
            testID="assistant-search"
          />
        ) : (
          <View
            testID="assistant-offline-icon"
            accessible
            accessibilityLabel={t('assistant.offline_short')}
            style={styles.icon}
          >
            <CloudOff size={22} color={ink} strokeWidth={theme.icon.strokeWidth} />
          </View>
        )
      }
    >
      <View testID="assistant-chat" style={{ flex: 1, display: listening ? 'none' : 'flex' }}>
        {rows.length === 0 ? (
          <View style={{ gap: theme.space[3], paddingHorizontal: pad, paddingTop: 18, paddingBottom: bottomRoom }}>
            {!online ? <OfflineBanner /> : null}
            <ChatEmpty />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            testID="assistant-chat-list"
            inverted
            data={rows}
            keyExtractor={(r) => r.m.id}
            renderItem={renderItem}
            initialNumToRender={10}
            maxToRenderPerBatch={8}
            windowSize={7}
            keyboardShouldPersistTaps="handled"
            // Inverted: the top padding is under the newest message — the room of the assistant strip (D2).
            contentContainerStyle={{ paddingHorizontal: pad, paddingTop: bottomRoom, paddingBottom: 18 - theme.space[3] }}
            ListFooterComponent={!online ? <View style={{ paddingTop: theme.space[3] }}><OfflineBanner /></View> : undefined}
            onScroll={(e) => {
              atEnd.current = e.nativeEvent.contentOffset.y <= AT_END;
            }}
            scrollEventThrottle={64}
            onScrollToIndexFailed={(info) => {
              listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            }}
          />
        )}
      </View>
    </PlaceScreen>
  );
}

const styles = StyleSheet.create({
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
