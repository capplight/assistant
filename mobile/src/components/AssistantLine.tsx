import { router } from 'expo-router';
import { ChevronDown, Mic, PencilLine, Plus, SendHorizontal } from 'lucide-react-native';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';

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
import { Button } from './ui/Button';
import { useCurrentPage } from './useCurrentPage';
import { lineInputMaxHeight } from './useKeyboard';
import { VoiceListening } from './VoiceListening';

/**
 * The persistent assistant line — one capsule (design-system §3 AssistantCapsule, ux-audit P0-1):
 * [+ 36] [Про: <page> ▾ · field] (mic 40), 52 high, `surface` + floating shadow, 8 above the tab bar.
 * The «Про: …» toggle sits inside the capsule (no row of its own) and steps aside while a phrase is typed;
 * at ≥150 % font it takes a line of its own inside the capsule, which then grows.
 * Same on every page, above the tabs. A typed phrase goes to the one conversation (src/chat): a
 * text answer shows in the banner above, a change shows on the page with «Отменить»; without the
 * server a note is saved here (offline-first). Voice is still a local record + outbox entry. Voice: fragments ≤3 min, no live transcription (R-17). «Без ИИ»: no mic —
 * «Написать» focuses the field (R-05) — and questions are a search by words, no AI call.
 */
export function AssistantLine({
  scope,
  compact = false,
  keyboardHeight = 0,
}: { scope?: 'all'; compact?: boolean; keyboardHeight?: number } = {}) {
  const theme = useTheme();
  const { height: windowHeight } = useWindowDimensions();
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
  // «Я в магазине»: only the chip and the mic until the person starts writing.
  const [opened, setOpened] = useState(false);
  const folded = compact && !opened && text.trim().length === 0;
  // Leaving the mode folds it again next time (state from the prop, no effect).
  const [wasCompact, setWasCompact] = useState(compact);
  if (wasCompact !== compact) {
    setWasCompact(compact);
    setOpened(false);
  }
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
      style={[styles.chip, { minHeight: theme.size.minTouch, paddingLeft: theme.space[1], gap: 2 }]}
    >
      <AppText variant="callout" color="ink2" style={[styles.shrink, { fontFamily: theme.type.sectionLabel.fontFamily }]}>
        {chipLabel}
      </AppText>
      <ChevronDown size={theme.size.iconSm} color={theme.colors.iconSecondary} strokeWidth={theme.icon.strokeWidth} />
    </Pressable>
  );

  // Week 17: a long phrase wraps and the field grows to a cap (4 lines, 3 at ≥150%, ≤30% of what the
  // keyboard leaves), then scrolls inside; the return key still sends.
  const inputMax = lineInputMaxHeight({
    lineHeight: theme.type.body.lineHeight ?? 24,
    fontScale: theme.fontScale,
    largeFont: theme.largeFont,
    windowHeight,
    keyboardHeight,
    padding: 16,
  });

  const field = (
    <TextInput
      ref={inputRef}
      testID="assistant-input"
      accessibilityLabel={t('line.a11y', { page: current.title })}
      accessibilityHint={t(current.hintKey)}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.ink3}
      value={text}
      onChangeText={setText}
      onSubmitEditing={send}
      returnKeyType="send"
      multiline
      submitBehavior="submit"
      scrollEnabled
      textAlignVertical="top"
      editable={consentGiven}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      style={[
        theme.type.body,
        styles.input,
        {
          color: theme.colors.ink,
          minHeight: theme.size.minTouch,
          maxHeight: inputMax,
          paddingHorizontal: theme.space[2],
        },
      ]}
    />
  );

  // The Pressable is the 48 target; the visible circle inside is 40 (mic / send) or 36 («+»).
  const target = { width: theme.size.minTouch, height: theme.size.minTouch };
  const circle = (d: number, bg: string) => [styles.round, { width: d, height: d, borderRadius: d / 2, backgroundColor: bg }];
  const mic = theme.size.assistantMic;
  const iconPx = theme.size.iconSm;
  const stroke = theme.icon.strokeWidth;

  // Right button: «Отправить» when typed; mic otherwise; «Написать» in «Без ИИ» (no voice, R-05).
  const right =
    text.trim().length > 0 ? (
      <Pressable
        testID="assistant-send"
        accessibilityRole="button"
        accessibilityLabel={t('line.send')}
        onPress={send}
        style={[styles.round, target]}
      >
        <View style={circle(mic, theme.colors.brand)}>
          <SendHorizontal size={iconPx} color={theme.colors.onBrand} strokeWidth={stroke} />
        </View>
      </Pressable>
    ) : noAi ? (
      <Pressable
        testID="assistant-write"
        accessibilityRole="button"
        accessibilityLabel={t('line.write')}
        onPress={() => {
          if (folded) setOpened(true);
          inputRef.current?.focus();
        }}
        style={[styles.round, target]}
      >
        <View style={circle(mic, theme.colors.brandTint)}>
          <PencilLine size={iconPx} color={theme.colors.brand} strokeWidth={stroke} />
        </View>
      </Pressable>
    ) : (
      <Pressable
        testID="assistant-mic"
        accessibilityRole="button"
        accessibilityLabel={t('line.mic')}
        disabled={!consentGiven}
        onPress={startVoice}
        style={[styles.round, target]}
      >
        <View style={circle(mic, theme.colors.brand)}>
          <Mic size={iconPx} color={theme.colors.onBrand} strokeWidth={stroke} />
        </View>
      </Pressable>
    );

  const plus = (
    <Pressable
      testID="assistant-plus"
      accessibilityRole="button"
      accessibilityLabel={t('line.plus_a11y')}
      onPress={() => setAddOpen(true)}
      style={[styles.round, target]}
    >
      <View style={circle(theme.size.assistantPlus, theme.colors.surfaceSunken)}>
        <Plus size={iconPx} color={theme.colors.ink2} strokeWidth={stroke} />
      </View>
    </Pressable>
  );

  return (
    <View
      testID="assistant-line"
      style={[
        {
          backgroundColor: theme.colors.surface,
          // Round while one line high; a grown capsule (listening, 200 %, a long phrase) keeps soft corners.
          borderRadius: theme.size.assistantCapsule / 2,
          marginHorizontal: theme.size.tabBarInset,
          padding: 2,
          gap: theme.space[1],
          minHeight: theme.size.assistantCapsule,
        },
        theme.elevation.floating,
      ]}
    >
      {voice.status === 'denied' ? (
        <View style={[styles.row, { gap: theme.space[2], paddingLeft: theme.space[3] }]} accessibilityLiveRegion="polite">
          <AppText variant="callout" style={styles.flex}>
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
      ) : folded ? (
        <View testID="assistant-line-folded" style={[styles.row, { gap: theme.space[2], justifyContent: 'space-between', paddingLeft: theme.space[3] }]}>
          <View style={styles.shrink}>{chip}</View>
          {right}
        </View>
      ) : theme.largeFont ? (
        // ≥150%: two rows — chip, then [+] field (mic)
        <>
          <View style={[styles.row, { paddingHorizontal: theme.space[3] }]}>{chip}</View>
          {/* The field grows upwards; [+] and mic / send stay at its bottom edge, within thumb reach. */}
          <View testID="assistant-line-row" style={[styles.row, styles.end]}>
            {plus}
            <View style={styles.flex}>{field}</View>
            {right}
          </View>
        </>
      ) : (
        <View testID="assistant-line-row" style={[styles.row, styles.end]}>
          {plus}
          {/* The «Про: …» toggle in the capsule while the field is empty; typing gives the field the room. */}
          {text.length === 0 ? <View style={styles.chipBox}>{chip}</View> : null}
          <View style={styles.flex}>{field}</View>
          {right}
        </View>
      )}
      <AddSheet
        visible={addOpen}
        onClose={() => setAddOpen(false)}
        expensesPageId={current.kind === 'page' && current.page.templateKey === 'expenses' ? current.page.id : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  end: { alignItems: 'flex-end' },
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  chipBox: { flexShrink: 1, maxWidth: '45%' },
  input: { paddingVertical: 12 },
  round: { alignItems: 'center', justifyContent: 'center' },
});
