import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/AppText';
import { AssistantLine } from '@/components/AssistantLine';
import { Button } from '@/components/Button';
import { useAssistant } from '@/store/assistant';
import { useTheme } from '@/theme';

/**
 * S36 «Переписка» — one conversation for all pages, full screen, «Свернуть» on top,
 * the same assistant line at the bottom. Week 1: placeholder over local messages only.
 * TODO(week 5): SSE answers, source chips, actions with «Отменить», focus on the opened answer.
 */
export default function ChatScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const messages = useAssistant((s) => s.messages);

  const time = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso.slice(11, 16);
    }
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
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
      </View>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: theme.screenPadding, gap: theme.space[3] }}>
          {messages.length === 0 ? <AppText color="ink2">{t('chat.empty')}</AppText> : null}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const divider = !prev || prev.pageId !== m.pageId;
            return (
              <View key={m.id} style={{ gap: theme.space[2] }}>
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
                  <AppText>{m.text}</AppText>
                )}
              </View>
            );
          })}
        </ScrollView>
        <AssistantLine scope="all" />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1 },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
});
