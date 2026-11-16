import { router, useLocalSearchParams } from 'expo-router';
import { History, Search } from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';

import { loadHistory, loadServerHistory } from '@/chat/service';
import { AppText } from '@/components/AppText';
import { AssistantMark, AssistantMessage, ChatEmpty, DaySeparator, OfflineBanner, UserBubble } from '@/components/chat/ChatParts';
import { Screen } from '@/components/Screen';
import { HeaderButton } from '@/components/ui/Header';
import { getRecords } from '@/db';
import { LIST_LIMIT, useLocalQuery } from '@/records/useRecords';
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
  const listening = useAssistant((s) => s.listening);
  const online = useConnectivity((s) => s.online);
  const records = useLocalQuery(async () => (await getRecords()).list(LIST_LIMIT), [messages.length]);
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

  const subtitle = listening
    ? t('assistant.listening')
    : !online
      ? t('assistant.offline_short')
      : messages.length === 0 || !records
        ? t('assistant.new')
        : t('assistant.remember_count', { count: records.length });

  const days = messages.map((m) => dayTitle(m.at));
  return (
    <Screen testID="assistant-screen" edges={['top']} scroll={false}>
      <View style={[styles.row, { gap: theme.space[3], paddingTop: theme.space[3], paddingBottom: theme.space[2] }]}>
        <AssistantMark size={36} />
        <View style={styles.flex}>
          <AppText variant="title2" accessibilityRole="header">
            {t('tabs.assistant')}
          </AppText>
          <AppText testID="assistant-subtitle" variant="footnote">
            {subtitle}
          </AppText>
        </View>
        <HeaderButton icon={Search} label={t('today.search')} onPress={() => router.navigate('/search')} testID="assistant-search" />
        <HeaderButton icon={History} label={t('more.history')} onPress={() => router.push('/history')} testID="assistant-history" />
      </View>
      <ScrollView
        ref={scrollRef}
        testID="assistant-chat"
        contentContainerStyle={{ paddingTop: theme.space[2], paddingBottom: theme.size.contentEndGap, gap: theme.space[3] }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => {
          if (!focus) scrollRef.current?.scrollToEnd({ animated: false });
        }}
      >
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
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
