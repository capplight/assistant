import { Mail, MessageCircle, Share2 } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { KpFileFormat, KpSendChannel } from '@/api/types';
import { clientSaw, defaultSendText, markSent, notSent, openSend, saveSendDraft, sendDraft, waLink, type OpenResult } from '@/kp/service';
import { getSharePort } from '@/kp/share';
import { sentVersion, shownData, useKp } from '@/kp/store';
import { kpTitle, kpView, money, shortDate } from '@/kp/view';
import { useTheme } from '@/theme';

import { AmountText } from '../AmountText';
import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { SegmentedControl } from '../ui/SegmentedControl';
import { ContactPhoneField } from './ContactPhoneField';
import { KpTextField } from './KpEdits';
import { KpPreview } from './KpPreview';

const CHANNELS: KpSendChannel[] = ['whatsapp', 'email', 'share'];
const FORMATS: KpFileFormat[] = ['pdf', 'docx'];
const CHANNEL_ICON = { whatsapp: MessageCircle, email: Mail, share: Share2 } as const;

/**
 * S18 «КП, шаг 3: отправка» as one confirmation (research pattern 8; R-15, R-16, decision №6): the sheet's
 * thumbnail, the file and the sum (the server's), «Кому», the channel (WhatsApp / почта / файл), the text — then
 * ONE button opens WhatsApp (the system «Поделиться» with the file), the mail app (the file attached) or
 * «Поделиться». The person picks the chat and presses ➤; nothing is sent by the app or the server. Back here:
 * «Отправили?» [Да] marks the version sent (frozen, its file kept), [Нет] marks nothing. The number, the address
 * and the text stay on this phone (a draft, offline too). Used by the editor's send sheet and by `/kp/send`.
 */
export function KpSendPanel({ docId, onDone }: { docId: string; onDone: () => void }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
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

  const data = doc ? shownData(docId, { versions, docEdits: edits }) : null;
  if (!doc || !data) return <AppText testID="kp-send-missing">{t('kp.no_version')}</AppText>;

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
  const thumb = theme.largeFont ? 0 : 72;

  return (
    <View testID="kp-send-panel" style={{ gap: theme.space[4] }}>
      {ask ? (
        // Back from WhatsApp / mail: the one question, [Да] not focused first (S25).
        <Card testID="kp-send-did" tone="brandTint">
          <View style={{ gap: theme.space[3] }}>
            <AppText variant="headline" accessibilityRole="header" accessibilityLiveRegion="polite">
              {t('send.did_you')}
            </AppText>
            <AppText>{t('send.did_you_body', { n: pending.n })}</AppText>
            <View style={{ flexDirection: 'row', gap: theme.space[2], flexWrap: 'wrap' }}>
              <Button testID="kp-send-did-no" label={t('send.did_no')} variant="secondary" style={{ flexGrow: 1 }} onPress={no} />
              <Button testID="kp-send-did-yes" label={t('send.did_yes')} style={{ flexGrow: 1 }} onPress={() => void yes()} />
            </View>
          </View>
        </Card>
      ) : null}
      {done === 'sent' ? (
        <View testID="kp-send-done" style={{ gap: theme.space[3] }}>
          <AppText color="success" accessibilityLiveRegion="polite">
            {t('send.marked', { date: shortDate(new Date().toISOString(), i18n.language) })}
          </AppText>
          <AppText variant="callout">{t('send.marked_note')}</AppText>
          <Button testID="kp-send-finish" label={t('send.finish')} onPress={onDone} />
        </View>
      ) : null}
      {done === 'not_sent' ? (
        <AppText testID="kp-send-not" accessibilityLiveRegion="polite">
          {t('send.not_marked')}
        </AppText>
      ) : null}

      <View style={{ flexDirection: 'row', gap: theme.space[3], alignItems: 'center' }}>
        {thumb ? <KpPreview testID="kp-send-thumb" doc={doc} view={v} width={thumb} /> : null}
        <View style={{ flex: 1, gap: theme.space[1] }}>
          <AppText testID="kp-send-file" variant="callout">
            {fileName}
          </AppText>
          {total ? (
            <AmountText testID="kp-send-total" variant="title2" inset={theme.screenPadding * 2 + thumb + theme.space[5] * 2}>
              {t('send.sum', { amount: total })}
            </AmountText>
          ) : (
            <AppText testID="kp-send-total" variant="headline" color="warning">
              {t('send.sum_missing', { count: missing })}
            </AppText>
          )}
          {waiting ? <AppText variant="footnote">{t('kp.waiting_sync')}</AppText> : null}
        </View>
      </View>

      {saw !== null ? (
        <Card testID="kp-send-saw" tone="sunken">
          <AppText>{t('send.client_saw', { n: saw })}</AppText>
        </Card>
      ) : sentN !== null && sentN === n ? (
        <AppText testID="kp-send-again" variant="callout">
          {t('send.already_sent', { n })}
        </AppText>
      ) : null}

      <View style={{ gap: theme.space[1] }}>
        <AppText variant="callout">{t('send.to')}</AppText>
        <AppText testID="kp-send-client" variant="headline">
          {clientName}
        </AppText>
      </View>

      <View testID="kp-send-channel" style={{ gap: theme.space[1] }}>
        <AppText variant="callout">{t('send.by')}</AppText>
        <SegmentedControl
          accessibilityLabel={t('send.by')}
          segments={CHANNELS.map((c) => ({ key: c, label: t(`send.ch_${c}`), testID: `kp-send-channel-${c}` }))}
          value={draft.channel}
          onChange={(k) => saveSendDraft(docId, { channel: k })}
        />
      </View>
      <View testID="kp-send-format" style={{ gap: theme.space[1] }}>
        <AppText variant="callout">{t('send.format')}</AppText>
        <SegmentedControl
          accessibilityLabel={t('send.format')}
          segments={FORMATS.map((f) => ({ key: f, label: t(`send.format_${f}`), testID: `kp-send-format-${f}` }))}
          value={draft.format}
          onChange={(k) => saveSendDraft(docId, { format: k })}
        />
      </View>

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
      {draft.channel === 'whatsapp' ? <ContactPhoneField testID="kp-send-phone" value={draft.phone} onChange={(x) => saveSendDraft(docId, { phone: x })} /> : null}

      <KpTextField testID="kp-send-text" label={t('send.text')} value={text} onChangeText={(x) => saveSendDraft(docId, { text: x })} multiline />
      {draft.text !== null ? (
        <Button testID="kp-send-text-reset" label={t('send.text_reset')} variant="text" style={{ alignSelf: 'flex-start' }} onPress={() => saveSendDraft(docId, { text: null })} />
      ) : null}

      <View testID="kp-send-hint" style={{ flexDirection: 'row', gap: theme.space[2], alignItems: 'flex-start' }}>
        <Icon icon={CHANNEL_ICON[draft.channel]} size="sm" color="iconSecondary" />
        <AppText variant="callout" style={{ flex: 1 }}>
          {hint}
        </AppText>
      </View>
      <Button
        testID="kp-send-open"
        label={busy ? t('send.busy') : openLabel}
        minHeight={56}
        icon={<Icon icon={CHANNEL_ICON[draft.channel]} size="sm" color="onBrand" />}
        disabled={busy || missing > 0}
        onPress={() => void open()}
      />
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
          <Button testID="kp-send-text-only" label={t('send.text_only')} variant="text" onPress={() => void textOnly()} />
          {textNote ? (
            <AppText testID="kp-send-text-note" color="warning">
              {textNote}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
