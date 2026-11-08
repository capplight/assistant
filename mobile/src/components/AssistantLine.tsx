import { router } from 'expo-router';
import { ChevronDown, Mic, PencilLine, Plus, SendHorizontal } from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { sendFromLine } from '@/chat/service';
import { getCapture } from '@/services';
import { MAX_FONT_SCALE, useTheme } from '@/theme';
import { useAssistant } from '@/store/assistant';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import type { Fragment } from '@/voice/session';
import { useVoiceRecorder } from '@/voice/useVoiceRecorder';

import { AddSheet } from './AddSheet';
import { AppText } from './AppText';
import { Button } from './Button';
import { useCurrentPage } from './useCurrentPage';
import { VoiceListening } from './VoiceListening';

/**
 * The persistent assistant line (F-37, R-52, 2-design §4.3): [+] [Про: <page> · field] (mic).
 * Same on every page, above the tabs. A typed phrase goes to the one conversation (src/chat): a
 * text answer shows in the banner above, a change shows on the page with «Отменить»; without the
 * server a note is saved here (offline-first). Voice is still a local record + outbox entry. Voice: fragments ≤3 min, no live transcription (R-17). «Без ИИ»: no mic —
 * «Написать» focuses the field (R-05) — and questions are a search by words, no AI call.
 */
export function AssistantLine({ scope }: { scope?: 'all' } = {}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const current = useCurrentPage();
  const noAi = useOnboarding(selectNoAi);
  const consentGiven = useOnboarding((s) => s.consent !== null);
  const store = useAssistant();
  const { setAboutAll, setListening } = store;
  const language = useOnboarding((s) => s.language);
  const showToast = useToast((s) => s.show);
  // In «Переписка» the line always works over all pages.
  const aboutAll = scope === 'all' || store.aboutAll;
  const [text, setText] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  // S04b follows the first result, once (R-60); later it is in «Ещё».
  const askPhoneOnce = () => {
    const s = useOnboarding.getState();
    if (!s.phoneAskedAt && !s.phoneLinkedAt) router.push('/phone');
  };

  // A change made by the assistant (a note it saved, «Разложил…») is a first result too.
  useEffect(
    () =>
      useUndo.subscribe((st, prev) => {
        if (scope !== 'all' && st.strip?.kind === 'action' && st.strip.id !== prev.strip?.id) askPhoneOnce();
      }),
    [scope],
  );

  const onVoiceFinished = async (fragments: Fragment[]) => {
    setListening(false);
    const capture = await getCapture();
    await capture.saveVoice({ fragments, pageId: current.id });
    showToast(t('saved'));
    askPhoneOnce();
  };
  const voice = useVoiceRecorder(onVoiceFinished);
  const listening = voice.status === 'listening';

  // A tip's [Да] on «Сегодня» (today.md `put_phrase`, `open_mic`): the person still sends it.
  const start = useRef(() => undefined as void);
  useEffect(() => {
    start.current = () => {
      if (consentGiven && !noAi) {
        setListening(true);
        void voice.start();
      } else inputRef.current?.focus();
    };
  });
  useEffect(() => {
    if (scope === 'all') return;
    const take = (r: ReturnType<typeof useView.getState>['lineRequest']) => {
      if (!r) return;
      useView.getState().requestLine(null);
      if (r.kind === 'text') {
        setText(r.text);
        inputRef.current?.focus();
      } else start.current();
    };
    take(useView.getState().lineRequest);
    return useView.subscribe((st, prev) => {
      if (st.lineRequest && st.lineRequest.id !== prev.lineRequest?.id) take(st.lineRequest);
    });
  }, [scope]);

  const startVoice = async () => {
    // Consent gate: no recording before S05; never in «Без ИИ» (voice needs AI, R-05).
    if (!consentGiven || noAi) return;
    setListening(true);
    await voice.start();
  };

  const chipLabel = aboutAll ? t('line.about_all') : t('line.about', { page: current.title });
  const placeholder = noAi ? t('line.no_ai_hint') : t('line.placeholder');

  const send = async () => {
    const value = text.trim();
    // Consent gate (3-engineering §6.14): nothing is sent before S05.
    if (!value || !consentGiven) return;
    setText('');
    // R-53: online the server decides what the phrase is (a question, a change, a note); offline
    // and in «Без ИИ» the phone guesses (src/chat/service.ts `sendFromLine`).
    const result = await sendFromLine(value, {
      id: current.id,
      title: current.title,
      serverId: current.kind === 'page' ? current.page.serverId : null,
    });
    if (result === 'search') {
      router.navigate({ pathname: '/search', params: { q: value, from: 'line' } });
      return;
    }
    if (result === 'saved') askPhoneOnce();
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
        onPress={startVoice}
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
      {voice.status === 'denied' ? (
        <View style={[styles.row, { gap: theme.space[2] }]} accessibilityLiveRegion="polite">
          <AppText variant="meta" style={styles.flex}>
            {t('voice.denied')}
          </AppText>
          <Button
            testID="voice-denied-write"
            label={t('line.write')}
            variant="text"
            onPress={() => {
              voice.resetDenied();
              setListening(false);
              inputRef.current?.focus();
            }}
          />
        </View>
      ) : null}
      {listening ? (
        <VoiceListening
          elapsedMs={voice.elapsedMs}
          level={voice.level}
          continuing={voice.continuing}
          kkBeta={language === 'kk'}
          onDone={() => void voice.finish()}
          onCancel={() => {
            setListening(false);
            void voice.cancel();
          }}
        />
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
