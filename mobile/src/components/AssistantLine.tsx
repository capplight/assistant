import { ChevronDown, Mic, PencilLine, Plus, SendHorizontal } from 'lucide-react-native';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { getOutbox } from '@/db';
import { MAX_FONT_SCALE, useTheme } from '@/theme';
import { useAssistant } from '@/store/assistant';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { newId } from '@/utils/id';

import { AddSheet } from './AddSheet';
import { AppText } from './AppText';
import { Button } from './Button';
import { useCurrentPage } from './useCurrentPage';

/**
 * The persistent assistant line (F-37, R-52, 2-design §4.3): [+] [Про: <page> · field] (mic).
 * Same on every page, above the tabs. Week 1: UI only — sending writes to the local outbox,
 * the mic shows the «Слушаю» state without recording (no live transcription by design, R-17).
 */
export function AssistantLine({ scope }: { scope?: 'all' } = {}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const current = useCurrentPage();
  const noAi = useOnboarding(selectNoAi);
  const consentGiven = useOnboarding((s) => s.consent !== null);
  const store = useAssistant();
  const { setAboutAll, listening, setListening, showBanner, addMessage } = store;
  // In «Переписка» the line always works over all pages.
  const aboutAll = scope === 'all' || store.aboutAll;
  const [text, setText] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  const chipLabel = aboutAll ? t('line.about_all') : t('line.about', { page: current.title });
  const placeholder = noAi ? t('line.no_ai_hint') : t('line.placeholder');

  const send = async () => {
    const value = text.trim();
    // Consent gate (3-engineering §6.14): nothing is sent before S05.
    if (!value || !consentGiven) return;
    setText('');
    const userMsg = {
      id: newId(),
      role: 'user' as const,
      text: value,
      pageId: current.id,
      pageTitle: current.title,
      at: new Date().toISOString(),
    };
    addMessage(userMsg);
    const outbox = await getOutbox();
    await outbox.enqueue(noAi ? 'capture.text' : 'chat.message', {
      clientId: userMsg.id,
      text: value,
      pageId: current.id,
      scope: aboutAll ? 'all' : 'page',
    });
    const reply = {
      id: newId(),
      role: 'assistant' as const,
      text: t('phrase.saved'),
      pageId: current.id,
      pageTitle: current.title,
      at: new Date().toISOString(),
    };
    addMessage(reply);
    showBanner({ messageId: reply.id, text: reply.text });
  };

  const chip = (
    <Pressable
      testID="context-chip"
      accessibilityRole="button"
      accessibilityLabel={aboutAll ? t('line.about_all_a11y') : t('line.about_a11y', { page: current.title })}
      disabled={scope === 'all'}
      onPress={() => setAboutAll(!aboutAll)}
      style={[
        styles.chip,
        {
          minHeight: theme.size.minTouch,
          borderRadius: theme.radius.chip,
          borderColor: theme.colors.lineStrong,
          paddingHorizontal: theme.space[3],
          gap: theme.space[1],
        },
      ]}
    >
      <AppText variant="meta" color="ink" style={styles.shrink}>
        {chipLabel}
      </AppText>
      <ChevronDown size={18} color={theme.colors.ink2} />
    </Pressable>
  );

  const field = (
    <TextInput
      ref={inputRef}
      testID="assistant-input"
      accessibilityLabel={t('line.a11y', { page: current.title })}
      accessibilityHint={t(current.hintKey)}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.ink2}
      value={text}
      onChangeText={setText}
      onSubmitEditing={send}
      returnKeyType="send"
      editable={consentGiven}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      style={[
        theme.type.body,
        styles.input,
        {
          color: theme.colors.ink,
          minHeight: theme.size.minTouch,
          borderColor: theme.colors.lineStrong,
          borderRadius: theme.radius.input,
          paddingHorizontal: theme.space[3],
          backgroundColor: theme.colors.bg,
        },
      ]}
    />
  );

  const roundBtn = { width: theme.size.mic, height: theme.size.mic, borderRadius: theme.radius.round };

  // Right button: «Отправить» when typed; mic otherwise; «Написать» in «Без ИИ» (no voice, R-05).
  const right =
    text.trim().length > 0 ? (
      <Pressable
        testID="assistant-send"
        accessibilityRole="button"
        accessibilityLabel={t('line.send')}
        onPress={send}
        style={[styles.round, roundBtn, { backgroundColor: theme.colors.accent }]}
      >
        <SendHorizontal size={26} color={theme.colors.onAccent} />
      </Pressable>
    ) : noAi ? (
      <Pressable
        testID="assistant-write"
        accessibilityRole="button"
        accessibilityLabel={t('line.write')}
        onPress={() => inputRef.current?.focus()}
        style={[styles.round, roundBtn, { borderWidth: 2, borderColor: theme.colors.accent }]}
      >
        <PencilLine size={26} color={theme.colors.accent} />
      </Pressable>
    ) : (
      <Pressable
        testID="assistant-mic"
        accessibilityRole="button"
        accessibilityLabel={t('line.mic')}
        disabled={!consentGiven}
        onPress={() => setListening(true)}
        style={[styles.round, roundBtn, { backgroundColor: theme.colors.accent }, theme.elevation?.mic]}
      >
        <Mic size={28} color={theme.colors.onAccent} />
      </Pressable>
    );

  const plus = (
    <Pressable
      testID="assistant-plus"
      accessibilityRole="button"
      accessibilityLabel={t('line.plus_a11y')}
      onPress={() => setAddOpen(true)}
      style={[
        styles.round,
        {
          width: theme.size.plus,
          height: theme.size.plus,
          borderRadius: theme.radius.round,
          borderWidth: 2,
          borderColor: theme.colors.lineStrong,
        },
      ]}
    >
      <Plus size={26} color={theme.colors.ink} />
    </Pressable>
  );

  return (
    <View
      testID="assistant-line"
      style={[
        styles.wrap,
        {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.line,
          paddingHorizontal: theme.space[3],
          paddingVertical: theme.space[2],
          gap: theme.space[2],
          minHeight: theme.size.assistantLine,
        },
      ]}
    >
      {listening ? (
        <View
          testID="assistant-listening"
          accessibilityLiveRegion="polite"
          style={[styles.row, { gap: theme.space[3] }]}
        >
          <View style={[styles.round, roundBtn, { borderWidth: 4, borderColor: theme.colors.accent }]}>
            <Mic size={28} color={theme.colors.accent} />
          </View>
          <AppText variant="bodyStrong" style={styles.flex}>
            {t('line.listening')}
          </AppText>
          <Button label={t('line.done')} onPress={() => setListening(false)} testID="assistant-listening-done" />
        </View>
      ) : theme.largeFont ? (
        // ≥150%: two rows — chip, then [+] field (mic)
        <>
          <View style={styles.row}>{chip}</View>
          <View style={[styles.row, { gap: theme.space[2] }]}>
            {plus}
            <View style={styles.flex}>{field}</View>
            {right}
          </View>
        </>
      ) : (
        <View style={[styles.row, { gap: theme.space[2] }]}>
          {plus}
          <View style={[styles.flex, { gap: theme.space[1] }]}>
            {chip}
            {field}
          </View>
          {right}
        </View>
      )}
      <AddSheet visible={addOpen} onClose={() => setAddOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderWidth: 1 },
  input: { borderWidth: 1, paddingVertical: 8 },
  round: { alignItems: 'center', justifyContent: 'center' },
});
