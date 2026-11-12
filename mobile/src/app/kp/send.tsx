import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { KpFileFormat, KpSendChannel } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { ContactPhoneField } from '@/components/kp/ContactPhoneField';
import { KpTextField } from '@/components/kp/KpEdits';
import { Screen } from '@/components/Screen';
import { clientSaw, defaultSendText, markSent, notSent, openSend, saveSendDraft, sendDraft, waLink, type OpenResult } from '@/kp/service';
import { getSharePort } from '@/kp/share';
import { sentVersion, shownData, useKp } from '@/kp/store';
import { kpTitle, kpView, money, shortDate } from '@/kp/view';
import { useTheme } from '@/theme';

const CHANNELS: KpSendChannel[] = ['whatsapp', 'email', 'share'];
const FORMATS: KpFileFormat[] = ['pdf', 'docx'];

/**
 * S18 «КП, шаг 3: отправка» (week 15; R-15, R-16, decision №6). The confirmation first: the file,
 * the sum (the server's), to whom, by what, the text — then one button opens WhatsApp (the system
 * «Поделиться» with the file), the mail app (the file attached) or «Поделиться». The person picks
 * the chat and presses ➤; nothing is sent by the app or the server. Back here: «Отправили?» [Да]
 * marks the version sent (frozen, its file kept), [Нет] marks nothing. The number, the address and
 * the text stay on this phone (a draft, offline too).
 */
export default function KpSendScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { doc: docId } = useLocalSearchParams<{ doc: string }>();
  const doc = useKp((s) => s.docs[docId]);
  const versions = useKp((s) => s.versions);
  const edits = useKp((s) => s.docEdits);
  const sentEdits = useKp((s) => s.sentEdits);
  const pending = useKp((s) => s.pendingSends[docId]);
  const draft = useKp((s) => s.sendDrafts[docId]) ?? sendDraft(docId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpenResult | null>(null);
  const [done, setDone] = useState<'sent' | 'not_sent' | null>(null);
  const [textNote, setTextNote] = useState<string | null>(null);

  const close = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/kp/[id]', params: { id: docId } }));
  const data = doc ? shownData(docId, { versions, docEdits: edits }) : null;
  if (!doc || !data) {
    return (
      <Screen testID="kp-send-screen">
        <AppText testID="kp-send-missing">{t('kp.no_version')}</AppText>
        <Button testID="kp-send-close" label={t('common.close')} variant="secondary" onPress={close} />
      </Screen>
    );
  }

  const version = versions[docId];
  const waiting = (edits[docId]?.rows.length ?? 0) > 0;
  const v = kpView(data, version, !!edits[docId]);
  const missing = v.counts.missing;
  const total = v.totals && missing === 0 ? money(v.totals.total) : null;
  const clientName = data.client.name ?? t('send.no_client');
  const chatName = data.client.contact?.trim() || data.client.name || t('send.no_client');
  const text = draft.text ?? defaultSendText(doc, data, total, t);
  const saw = clientSaw({ ...doc, sent_version_n: sentVersion(doc, { sentEdits }) });
  const sentN = sentVersion(doc, { sentEdits });
  const n = doc.current_version_n ?? version?.n ?? 1;
  const fileName = t(draft.format === 'docx' ? 'send.file_docx' : 'send.file_pdf', { title: kpTitle(doc, t), n });
  const subject = t('send.subject', { title: kpTitle(doc, t) });
  const ask = pending && !done;

  const open = async () => {
    setBusy(true);
    setResult(null);
    setDone(null);
    const r = await openSend(docId, { channel: draft.channel, format: draft.format, missing, text, email: draft.email, subject, recipientName: data.client.contact?.trim() || null });
    setBusy(false);
    setResult(r);
  };

  const textOnly = async () => {
    const port = getSharePort();
    const ok = port.openUrl ? await port.openUrl(waLink(draft.phone, text)) : false;
    setTextNote(ok ? null : t('send.wa_failed'));
  };

  const yes = async () => {
    if (!pending) return;
    await markSent(docId, pending.n, pending.channel);
    setDone('sent');
  };
  const no = () => {
    void notSent(docId);
    setDone('not_sent');
  };

  const hint = draft.channel === 'whatsapp' ? t('send.wa_hint', { name: chatName }) : draft.channel === 'email' ? t('send.mail_hint') : t('send.share_hint');
  const openLabel = draft.channel === 'whatsapp' ? t('send.open_wa') : draft.channel === 'email' ? t('send.open_mail') : t('send.open_share');
  const problem =
    result && result.result !== 'opened'
      ? result.result === 'fields'
        ? t('kp.fields_missing', { list: (result.fields ?? []).map((f) => t(`kp.req_${f.replace('.', '_')}`, { defaultValue: f })).join(', ') })
        : t(`send.err_${result.result}`)
      : null;

  return (
    <Screen testID="kp-send-screen">
      <View style={{ gap: theme.space[4] }}>
        <View style={styles.row}>
          <AppText variant="largeTitle" accessibilityRole="header" style={{ flexShrink: 1 }}>
            {t('send.title')}
          </AppText>
          <Button testID="kp-send-close" label={t('common.close')} variant="text" minHeight={theme.size.minTouch} style={{ marginLeft: 'auto' }} onPress={close} />
        </View>

        {ask ? (
          // Back from WhatsApp / mail: the one question, [Да] not focused first (S25).
          <View testID="kp-send-did" style={{ gap: theme.space[3], padding: theme.space[4], borderRadius: theme.radius.lg, borderWidth: 2, borderColor: theme.colors.brand }}>
            <AppText variant="title2" accessibilityRole="header" accessibilityLiveRegion="polite">
              {t('send.did_you')}
            </AppText>
            <AppText>{t('send.did_you_body', { n: pending.n })}</AppText>
            <View style={[styles.row, { gap: theme.space[3], flexWrap: 'wrap' }]}>
              <Button testID="kp-send-did-no" label={t('send.did_no')} variant="secondary" style={{ flexGrow: 1 }} onPress={no} />
              <Button testID="kp-send-did-yes" label={t('send.did_yes')} style={{ flexGrow: 1 }} onPress={() => void yes()} />
            </View>
          </View>
        ) : null}
        {done === 'sent' ? (
          <View testID="kp-send-done" style={{ gap: theme.space[3] }}>
            <AppText color="success" accessibilityLiveRegion="polite">
              {t('send.marked', { date: shortDate(new Date().toISOString(), i18n.language) })}
            </AppText>
            <AppText variant="callout">{t('send.marked_note')}</AppText>
            <Button testID="kp-send-finish" label={t('send.finish')} onPress={close} />
          </View>
        ) : null}
        {done === 'not_sent' ? (
          <AppText testID="kp-send-not" accessibilityLiveRegion="polite">
            {t('send.not_marked')}
          </AppText>
        ) : null}

        <View style={{ gap: theme.space[1] }}>
          <AppText testID="kp-send-file" variant="bodyStrong">
            {fileName}
          </AppText>
          <AppText testID="kp-send-total" variant="title2" style={{ fontVariant: ['tabular-nums'] }}>
            {total ? t('send.sum', { amount: total }) : t('send.sum_missing', { count: missing })}
          </AppText>
          {waiting ? <AppText variant="callout">{t('kp.waiting_sync')}</AppText> : null}
        </View>

        {saw !== null ? (
          <View testID="kp-send-saw" style={{ padding: theme.space[3], backgroundColor: theme.colors.highlightTint, borderRadius: theme.radius.lg }}>
            <AppText>{t('send.client_saw', { n: saw })}</AppText>
          </View>
        ) : sentN !== null && sentN === n ? (
          <AppText testID="kp-send-again" variant="callout">
            {t('send.already_sent', { n })}
          </AppText>
        ) : null}

        <Choice
          testID="kp-send-format"
          title={t('send.format')}
          options={FORMATS.map((f) => ({ key: f, label: t(`send.format_${f}`) }))}
          value={draft.format}
          onPick={(k) => saveSendDraft(docId, { format: k as KpFileFormat })}
        />

        <View style={{ gap: theme.space[1] }}>
          <AppText variant="callout">{t('send.to')}</AppText>
          <AppText testID="kp-send-client" variant="bodyStrong">
            {clientName}
          </AppText>
        </View>

        <Choice
          testID="kp-send-channel"
          title={t('send.by')}
          options={CHANNELS.map((c) => ({ key: c, label: t(`send.ch_${c}`) }))}
          value={draft.channel}
          onPick={(k) => saveSendDraft(docId, { channel: k as KpSendChannel })}
        />

        {draft.channel === 'email' ? (
          <KpTextField
            testID="kp-send-email"
            label={t('send.email')}
            value={draft.email}
            onChangeText={(x) => saveSendDraft(docId, { email: x })}
            keyboardType="email-address"
            autoCapitalize="none"
          />
        ) : null}

        <KpTextField testID="kp-send-text" label={t('send.text')} value={text} onChangeText={(x) => saveSendDraft(docId, { text: x })} multiline />
        {draft.text !== null ? (
          <Button testID="kp-send-text-reset" label={t('send.text_reset')} variant="text" minHeight={theme.size.minTouch} onPress={() => saveSendDraft(docId, { text: null })} />
        ) : null}

        <View testID="kp-send-hint" style={{ padding: theme.space[3], borderRadius: theme.radius.lg, borderWidth: 1, borderColor: theme.colors.iconSecondary }}>
          <AppText>{hint}</AppText>
        </View>
        <Button testID="kp-send-open" label={busy ? t('send.busy') : openLabel} disabled={busy || missing > 0} onPress={() => void open()} />
        {missing > 0 ? (
          <AppText testID="kp-send-missing-prices" color="warning">
            {t('kp.pdf_missing')}
          </AppText>
        ) : null}
        {problem ? (
          <AppText testID="kp-send-problem" color="warning" accessibilityLiveRegion="polite">
            {problem}
          </AppText>
        ) : null}

        {draft.channel === 'whatsapp' ? (
          <View style={{ gap: theme.space[2] }}>
            <ContactPhoneField testID="kp-send-phone" value={draft.phone} onChange={(x) => saveSendDraft(docId, { phone: x })} />
            <Button testID="kp-send-text-only" label={t('send.text_only')} variant="secondary" onPress={() => void textOnly()} />
            {textNote ? (
              <AppText testID="kp-send-text-note" color="warning">
                {textNote}
              </AppText>
            ) : null}
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

/** A few options in a row of 56 pt radio buttons (one column at a large font: they wrap). */
function Choice({
  testID,
  title,
  options,
  value,
  onPick,
}: {
  testID: string;
  title: string;
  options: { key: string; label: string }[];
  value: string;
  onPick: (key: string) => void;
}) {
  const theme = useTheme();
  return (
    <View testID={testID} accessibilityRole="radiogroup" accessibilityLabel={title} style={{ gap: theme.space[1] }}>
      <AppText variant="callout">{title}</AppText>
      <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
        {options.map((o) => {
          const on = o.key === value;
          return (
            <Pressable
              key={o.key}
              testID={`${testID}-${o.key}`}
              accessibilityRole="radio"
              accessibilityLabel={o.label}
              accessibilityState={{ checked: on }}
              onPress={() => onPick(o.key)}
              style={{
                minHeight: theme.size.buttonHeight,
                paddingHorizontal: theme.space[4],
                justifyContent: 'center',
                borderRadius: theme.radius.md,
                borderWidth: 2,
                borderColor: on ? theme.colors.brand : theme.colors.iconSecondary,
                backgroundColor: on ? theme.colors.brand : theme.colors.surface,
                flexGrow: 1,
              }}
            >
              <AppText color={on ? 'onBrand' : 'ink'} style={{ textAlign: 'center' }}>{`${on ? '● ' : '○ '}${o.label}`}</AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
