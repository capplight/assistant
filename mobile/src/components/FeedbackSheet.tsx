import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { FeedbackReason } from '@/api/types';
import { reportProblem } from '@/chat/service';
import type { ChatMessage } from '@/store/assistant';
import { useToast } from '@/store/toast';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
import { CheckRow as Checkbox } from './ui/Check';

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
    <Modal visible={message !== null} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
          <SafeAreaView
            edges={['bottom']}
            testID="feedback-sheet"
            style={[
              {
                backgroundColor: theme.colors.surface,
                borderTopLeftRadius: theme.radius.sheet,
                borderTopRightRadius: theme.radius.sheet,
                maxHeight: '90%',
              },
              theme.elevation.floating,
            ]}
          >
            <ScrollView contentContainerStyle={{ padding: theme.space[5], gap: theme.space[2] }}>
              <AppText variant="title2" accessibilityRole="header">
                {t('feedback.title')}
              </AppText>
              <View accessibilityRole="radiogroup" style={{ gap: theme.space[1] }}>
                {REASONS.map((r) => {
                  const on = reason === r;
                  return (
                    <Pressable
                      key={r}
                      testID={`feedback-reason-${r}`}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={t(`feedback.reason.${r}`)}
                      onPress={() => setReason(r)}
                      style={[styles.row, { minHeight: theme.size.buttonHeight, gap: theme.space[3] }]}
                    >
                      <View
                        style={[
                          styles.radio,
                          { borderColor: on ? theme.colors.brand : theme.colors.iconSecondary, borderRadius: theme.radius.round },
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
                placeholderTextColor={theme.colors.ink2}
                value={comment}
                onChangeText={setComment}
                multiline
                maxLength={1000}
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                style={[
                  theme.type.body,
                  {
                    minHeight: theme.size.buttonHeight * 1.5,
                    borderWidth: 1,
                    borderColor: theme.colors.iconSecondary,
                    borderRadius: theme.radius.sm,
                    padding: theme.space[3],
                    color: theme.colors.ink,
                    backgroundColor: theme.colors.bg,
                    textAlignVertical: 'top',
                  },
                ]}
              />
              <Checkbox testID="feedback-allow" label={t('feedback.allow')} checked={allow} onChange={setAllow} />
              <AppText variant="callout">{t('feedback.where')}</AppText>
              <Button testID="feedback-send" label={t('feedback.send')} disabled={!reason} onPress={() => void send()} />
              <Button testID="feedback-cancel" label={t('common.close')} variant="text" onPress={close} />
            </ScrollView>
          </SafeAreaView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  row: { flexDirection: 'row', alignItems: 'center' },
  radio: { width: 28, height: 28, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 14, height: 14 },
});
