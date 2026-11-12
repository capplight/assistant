import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import type { KpDataOut } from '@/api/types';
import { describeChange, phraseEdit, undoPhrase, type PhraseResult } from '@/kp/service';
import type { PhraseChange } from '@/kp/store';
import { useToast } from '@/store/toast';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../ui/Button';

/**
 * Week 15 (S17, R-30): a change by a phrase. «Скажите, что изменить» → the server (KP_EDIT) →
 * applied at once; the box «Изменил: скидка 5% на кабель. Итого: 1 240 000 → 1 218 500 ₸» with
 * [Что изменилось] and [Отменить]. Every number in it is the server's.
 */

/** A labelled text field, 56 pt, with its label read out (S18 form, the phrase line). */
export function KpTextField({ label, testID, style, multiline, ...rest }: TextInputProps & { label: string; testID: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[1] }}>
      <AppText variant="callout">{label}</AppText>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        placeholderTextColor={theme.colors.ink2}
        multiline={multiline}
        style={[
          theme.type.body,
          {
            color: theme.colors.ink,
            minHeight: multiline ? theme.size.buttonHeight * 2 : theme.size.buttonHeight,
            borderWidth: 1,
            borderColor: theme.colors.iconSecondary,
            borderRadius: theme.radius.sm,
            paddingHorizontal: theme.space[3],
            paddingVertical: multiline ? theme.space[2] : 0,
            backgroundColor: theme.colors.surface,
            textAlignVertical: multiline ? 'top' : 'center',
          },
          style,
        ]}
        {...rest}
      />
    </View>
  );
}

const resultKey: Record<Exclude<PhraseResult['result'], 'applied'>, string> = {
  nothing: 'kp.phrase_nothing',
  offline: 'kp.phrase_offline',
  no_ai: 'kp.phrase_no_ai',
  waiting: 'kp.pdf_waiting',
  failed: 'kp.phrase_failed',
};

/** «Скажите, что изменить»: one phrase, sent when the person taps «Изменить». */
export function PhraseLine({ docId, assistant }: { docId: string; assistant: boolean }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!assistant) {
    // «Без ИИ»: a phrase needs the assistant; every field still changes by hand.
    return (
      <AppText testID="kp-phrase-no-ai" variant="callout">
        {t('kp.phrase_no_ai')}
      </AppText>
    );
  }

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setNote(null);
    const r = await phraseEdit(docId, text);
    setBusy(false);
    if (r.result === 'applied') {
      setText('');
      return;
    }
    // The phrase stays in the field: the person can send it again or change it by hand.
    setNote((r.result !== 'nothing' && r.result !== 'failed' ? null : r.message) || t(resultKey[r.result]));
  };

  return (
    <View testID="kp-phrase" style={{ gap: theme.space[2] }}>
      <KpTextField
        testID="kp-phrase-input"
        label={t('kp.phrase_label')}
        placeholder={t('kp.phrase_hint')}
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => void send()}
        returnKeyType="send"
        editable={!busy}
      />
      <Button
        testID="kp-phrase-send"
        label={busy ? t('kp.phrase_busy') : t('kp.phrase_send')}
        variant="secondary"
        disabled={busy || !text.trim()}
        onPress={() => void send()}
      />
      {note ? (
        <AppText testID="kp-phrase-note" color="warning" accessibilityLiveRegion="polite">
          {note}
        </AppText>
      ) : null}
    </View>
  );
}

/** «Изменил: … Итого: было → стало ₸ [Что изменилось] [Отменить]» (highlightTint, string 40). */
export function PhraseChangeBox({ docId, change, before, after }: { docId: string; change: PhraseChange; before: KpDataOut | null; after: KpDataOut }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rows = before ? describeChange(before, after, t) : [];
  const total = change.changeText && change.changeText !== t('kp.changed_short') ? ` ${change.changeText}` : '';
  const line = `${t('kp.phrase_changed', { what: change.text })}${total}`;
  const undo = async () => {
    const r = await undoPhrase(docId);
    const toast = useToast.getState();
    if (r.result === 'partial') toast.show(r.message || t('kp.undo_partial'), 5000);
    else if (r.result === 'failed') toast.show(r.message || t('kp.undo_failed'), 5000);
    else toast.show(t('kp.undo_done'), 3000);
  };
  return (
    <View testID="kp-change" style={{ gap: theme.space[2], padding: theme.space[3], backgroundColor: theme.colors.highlightTint, borderRadius: theme.radius.lg }}>
      <AppText testID="kp-change-text" accessibilityLiveRegion="polite">
        {line}
      </AppText>
      {open ? (
        <View testID="kp-change-rows" style={{ gap: theme.space[1] }}>
          {rows.length > 0 ? (
            rows.map((r) => (
              <AppText key={r.key} testID={`kp-change-row-${r.key}`}>
                {`• ${r.text}`}
              </AppText>
            ))
          ) : (
            <AppText variant="callout">{t('kp.diff_unknown')}</AppText>
          )}
        </View>
      ) : null}
      <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
        <Button
          testID="kp-change-what"
          label={open ? t('kp.diff_hide') : t('kp.diff_show')}
          variant="text"
          minHeight={theme.size.minTouch}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((x) => !x)}
        />
        <Button testID="kp-change-undo" label={t('common.undo')} variant="secondary" minHeight={theme.size.minTouch} onPress={() => void undo()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
