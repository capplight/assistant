import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { FeedbackReason } from '@/api/types';
import { reportProblem } from '@/chat/service';
import type { ChatMessage } from '@/store/assistant';
import { useToast } from '@/store/toast';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
import { CheckRow as Checkbox } from './ui/Check';
import { Sheet } from './ui/Sheet';

const REASONS: FeedbackReason[] = ['wrong', 'offensive', 'other'];

/**
 * «Ещё → Сообщить о проблеме» under an answer (R-41, Google Play rule for generated content).
 * One reason, an optional comment, and the separate tick for an anonymised example (R-23):
 * off by default. Goes through the outbox, so it is not lost offline.
 */
export function FeedbackSheet({ message, onClose }: { message: ChatMessage | null; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const [reason, setReason] = useState<FeedbackReason | null>(null);
  const [comment, setComment] = useState('');
  const [allow, setAllow] = useState(false);

  const close = () => {
    setReason(null);
    setComment('');
    setAllow(false);
    onClose();
  };

  const send = async () => {
    if (!message || !reason) return;
    await reportProblem(message, { reason, comment, allowExample: allow });
    showToast(t('feedback.thanks'), 2000);
    close();
  };

  return (
    <Sheet
      testID="feedback-sheet"
      visible={message !== null}
      onClose={close}
      title={t('feedback.title')}
      closeButton={false}
      footer={
        <>
          <Button testID="feedback-send" label={t('feedback.send')} disabled={!reason} onPress={() => void send()} />
          <Button testID="feedback-cancel" label={t('common.close')} variant="text" onPress={close} />
        </>
      }
    >
      <View accessibilityRole="radiogroup">
        {REASONS.map((r, i) => {
          const on = reason === r;
          return (
            <Pressable
              key={r}
              testID={`feedback-reason-${r}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={t(`feedback.reason.${r}`)}
              onPress={() => setReason(r)}
              style={[
                styles.row,
                { minHeight: theme.size.rowHeight, gap: theme.space[3] },
                i < REASONS.length - 1 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.separator } : null,
              ]}
            >
              <View
                style={[
                  styles.radio,
                  { borderWidth: theme.icon.strokeWidth, borderColor: on ? theme.colors.brand : theme.colors.iconSecondary, borderRadius: theme.radius.round },
                ]}
              >
                {on ? <View style={[styles.dot, { backgroundColor: theme.colors.brand, borderRadius: theme.radius.round }]} /> : null}
              </View>
              <AppText style={styles.flex}>{t(`feedback.reason.${r}`)}</AppText>
            </Pressable>
          );
        })}
      </View>
      <TextInput
        testID="feedback-comment"
        accessibilityLabel={t('feedback.comment')}
        placeholder={t('feedback.comment')}
        placeholderTextColor={theme.colors.ink3}
        value={comment}
        onChangeText={setComment}
        multiline
        maxLength={1000}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={[
          theme.type.body,
          {
            minHeight: theme.size.buttonHeight * 1.5,
            borderRadius: theme.radius.sm,
            padding: theme.space[3],
            color: theme.colors.ink,
            backgroundColor: theme.colors.surfaceSunken,
            textAlignVertical: 'top',
          },
        ]}
      />
      <Checkbox testID="feedback-allow" label={t('feedback.allow')} checked={allow} onChange={setAllow} />
      <AppText variant="callout">{t('feedback.where')}</AppText>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  radio: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 12, height: 12 },
});
