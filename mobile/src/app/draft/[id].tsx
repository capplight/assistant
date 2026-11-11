import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { ContactPhoneField } from '@/components/kp/ContactPhoneField';
import { KpTextField } from '@/components/kp/KpEdits';
import { CheckBadge } from '@/components/kp/KpParts';
import { Screen } from '@/components/Screen';
import { StandaloneUndoStrip } from '@/components/UndoStrip';
import { answerDraft, discardDraft, editDraftText, openDraft, type DraftOpenResult } from '@/kp/service';
import { shownDraft, useKp } from '@/kp/store';
import { useTheme } from '@/theme';

/**
 * F-15 / US-13 (S25 for a message): the text the assistant wrote, to whom and by what, then
 * [Открыть WhatsApp] / [Открыть почту] — the person presses ➤ there — [Изменить] (the text here
 * is editable, offline too) and [Не надо]. Back: «Отправили?» [Да] [Нет]. The number is typed
 * here and never goes to the server (R-16). One «ИИ» label under the text (R-06: a draft).
 */
export default function DraftScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const raw = useKp((s) => s.drafts[id]);
  const edit = useKp((s) => s.draftEdits[id]);
  const draft = raw ? shownDraft(id, { drafts: { [id]: raw }, draftEdits: edit ? { [id]: edit } : {} }) : null;
  const ask = useKp((s) => s.draftAsks[id]);
  const [text, setText] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DraftOpenResult | null>(null);
  const [answered, setAnswered] = useState<'sent' | 'not_sent' | null>(null);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (!draft || draft.status === 'discarded') {
    return (
      <View style={{ flex: 1 }}>
        <Screen testID="draft-screen">
          <View style={{ gap: theme.space[4] }}>
            <AppText testID="draft-gone">{t('draft.gone')}</AppText>
            <Button testID="draft-close" label={t('common.close')} variant="outline" onPress={close} />
          </View>
        </Screen>
        <StandaloneUndoStrip />
      </View>
    );
  }

  const email_ = draft.channel === 'email';
  const shownText = text ?? draft.text;
  const commit = () => {
    if (text !== null) void editDraftText(id, text);
    setText(null);
  };
  const open = async () => {
    commit();
    setBusy(true);
    setResult(await openDraft(id, { phone, email }));
    setBusy(false);
  };

  return (
    <View style={{ flex: 1 }}>
      <Screen testID="draft-screen">
        <View style={{ gap: theme.space[4] }}>
          <View style={styles.row}>
            <AppText variant="title1" accessibilityRole="header" style={{ flexShrink: 1 }}>
              {email_ ? t('draft.title_mail') : t('draft.title_wa')}
            </AppText>
            <Button testID="draft-close" label={t('common.close')} variant="text" minHeight={theme.size.minTouch} style={{ marginLeft: 'auto' }} onPress={close} />
          </View>

          {ask && !answered ? (
            <View testID="draft-did" style={{ gap: theme.space[3], padding: theme.space[4], borderRadius: theme.radius.card, borderWidth: 2, borderColor: theme.colors.accent }}>
              <AppText variant="title2" accessibilityRole="header" accessibilityLiveRegion="polite">
                {t('send.did_you')}
              </AppText>
              <View style={[styles.row, { gap: theme.space[3], flexWrap: 'wrap' }]}>
                <Button
                  testID="draft-did-no"
                  label={t('send.did_no')}
                  variant="outline"
                  style={{ flexGrow: 1 }}
                  onPress={() => {
                    void answerDraft(id, false);
                    setAnswered('not_sent');
                  }}
                />
                <Button
                  testID="draft-did-yes"
                  label={t('send.did_yes')}
                  style={{ flexGrow: 1 }}
                  onPress={() => {
                    void answerDraft(id, true);
                    setAnswered('sent');
                  }}
                />
              </View>
            </View>
          ) : null}
          {answered === 'sent' || draft.status === 'sent' ? (
            <View testID="draft-sent" style={{ gap: theme.space[2] }}>
              <AppText color="done">{t('send.marked_note')}</AppText>
              <Button testID="draft-finish" label={t('send.finish')} onPress={close} />
            </View>
          ) : null}
          {answered === 'not_sent' ? <AppText testID="draft-not-sent">{t('send.not_marked')}</AppText> : null}

          <View style={{ gap: theme.space[1] }}>
            <AppText variant="meta">{t('send.to')}</AppText>
            <AppText testID="draft-to" variant="bodyStrong">
              {draft.recipient_name ?? t('send.no_client')}
            </AppText>
            <AppText variant="meta">{`${t('send.by')}: ${email_ ? t('send.ch_email') : t('send.ch_whatsapp')}`}</AppText>
          </View>

          <KpTextField testID="draft-text" label={t('send.text')} value={shownText} onChangeText={setText} onEndEditing={commit} onBlur={commit} multiline />
          {draft.review_fields.includes('text') ? (
            <View style={[styles.row, { gap: theme.space[2], flexWrap: 'wrap' }]}>
              <CheckBadge testID="draft-check" />
              <AppText variant="meta" style={{ flexShrink: 1 }}>
                {t('draft.check_number')}
              </AppText>
            </View>
          ) : null}
          {draft.ai_generated ? (
            <AppText testID="draft-ai-label" variant="meta">
              {t('ai.label')}
            </AppText>
          ) : null}

          {email_ ? (
            <KpTextField testID="draft-email" label={t('send.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
          ) : (
            <ContactPhoneField testID="draft-phone" value={phone} onChange={setPhone} />
          )}
          <View testID="draft-hint" style={{ padding: theme.space[3], borderRadius: theme.radius.card, borderWidth: 1, borderColor: theme.colors.lineStrong }}>
            <AppText>{email_ ? t('send.mail_hint') : t('send.wa_hint', { name: draft.recipient_name ?? t('send.no_client') })}</AppText>
          </View>
          <Button
            testID="draft-open"
            label={busy ? t('send.busy') : email_ ? t('send.open_mail') : t('send.open_wa')}
            disabled={busy || draft.status !== 'draft'}
            onPress={() => void open()}
          />
          {result && result.result !== 'opened' ? (
            <AppText testID="draft-problem" color="warnText" accessibilityLiveRegion="polite">
              {result.message || t(`draft.err_${result.result}`)}
            </AppText>
          ) : null}
          {draft.status === 'draft' ? (
            <Button
              testID="draft-discard"
              label={t('draft.discard')}
              variant="text"
              minHeight={theme.size.minTouch}
              onPress={() => {
                void discardDraft(id);
              }}
            />
          ) : null}
        </View>
      </Screen>
      <StandaloneUndoStrip />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
