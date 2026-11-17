import { router, useLocalSearchParams } from 'expo-router';
import { CloudOff, History, Search } from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';

import { loadHistory, loadServerHistory } from '@/chat/service';
import { AssistantMessage, ChatEmpty, DaySeparator, OfflineBanner, UserBubble } from '@/components/chat/ChatParts';
import { PlaceScreen, SheetIcon } from '@/components/ui/PlaceScreen';
import { useAssistant } from '@/store/assistant';
import { useConnectivity } from '@/store/connectivity';
import { useTheme } from '@/theme';

const DAY = 86_400_000;

/**
 * «Помощник» — the centre tab (VISION-2026-11, v4 «Чат — центр»): one conversation for the whole app. The header —
 * the glowing mark, «Помощник», «помню 412 записей» / «слушаю…» / «нет связи» / «новый разговор», 🔍 and «История».
 * Messages: yours on the right (from the line of another tab — «с вкладки «Заметки»»), answers on the left with
 * their sources, results of changes as cards («Сделал 3 дела · Переложить · Отменить всё»). A new conversation shows
 * the tagline and four examples. The line below (MainFooter) writes into this same conversation.
 */
export default function AssistantScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const messages = useAssistant((s) => s.messages);
  const online = useConnectivity((s) => s.online);
  // «Помощник · голос»: while it listens the paper holds only the voice view (in the field below).
  const listening = useAssistant((s) => s.listening);
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [focusY, setFocusY] = useState<number | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    void loadServerHistory().then((ok) => {
      if (!ok) void loadHistory();
    });
  }, []);

  useEffect(() => {
    if (focusY !== null) scrollRef.current?.scrollTo({ y: Math.max(0, focusY - 16), animated: false });
  }, [focusY]);

  const dayTitle = (iso: string) => {
    const ms = new Date(iso).getTime();
    const d = new Date(ms).toDateString();
    if (d === new Date(now).toDateString()) return t('history.today');
    if (d === new Date(now - DAY).toDateString()) return t('history.yesterday');
    try {
      return new Date(ms).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' });
    } catch {
      return d;
    }
  };

  const days = messages.map((m) => dayTitle(m.at));
  const ink = theme.colors.onSheet;
  return (
    <PlaceScreen
      testID="assistant-screen"
      place="assistant"
      mode="strip"
      peek={['today', 'notes']}
      title={t('tabs.assistant')}
      scrollRef={scrollRef}
      onContentSizeChange={() => {
        if (!focus) scrollRef.current?.scrollToEnd({ animated: false });
      }}
      contentContainerStyle={{ paddingBottom: theme.m.ask.listBottomPadding + 22, gap: theme.space[3] }}
      stripLeft={<SheetIcon icon={History} label={t('more.history')} onPress={() => router.push('/history')} color={ink} testID="assistant-history" />}
      stripRight={
        online ? (
          <SheetIcon icon={Search} label={t('today.search')} onPress={() => router.navigate('/search')} color={ink} testID="assistant-search" />
        ) : (
          <View testID="assistant-offline-icon" accessible accessibilityLabel={t('assistant.offline_short')} style={styles.icon}>
            <CloudOff size={22} color={ink} strokeWidth={theme.icon.strokeWidth} />
          </View>
        )
      }
    >
      <View testID="assistant-chat" style={{ gap: theme.space[3], display: listening ? 'none' : 'flex' }}>
        {!online ? <OfflineBanner /> : null}
        {messages.length === 0 ? <ChatEmpty /> : null}
        {messages.map((m, i) => {
          const day = days[i]!;
          const header = i === 0 || days[i - 1] !== day;
          return (
            <View key={m.id} onLayout={focus && m.id === focus ? (ev) => setFocusY(ev.nativeEvent.layout.y) : undefined} style={{ gap: theme.space[3] }}>
              {header ? <DaySeparator label={day} /> : null}
              {m.role === 'user' ? <UserBubble m={m} testID={`chat-user-${m.id}`} /> : <AssistantMessage m={m} testID={`chat-msg-${m.id}`} />}
            </View>
          );
        })}
      </View>
    </PlaceScreen>
  );
}

const styles = StyleSheet.create({
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
