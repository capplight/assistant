import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { KpVersionOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { loadVersion, revertTo, shareKpFile, type FileResult } from '@/kp/service';
import { cachedVersion, sentVersion, useKp } from '@/kp/store';
import { kpView, money, priceLabel, priceMoney, qtyShown, shortDate, vatText } from '@/kp/view';
import { useTheme } from '@/theme';

/**
 * Week 15: one version as it was — read only. The sent one is frozen («Эту версию получил
 * клиент»); its file is kept by the server (Ф-5) and can be fetched again. «Вернуть эту» makes a
 * new version equal to it (with «Отменить»), offline too when the phone holds it.
 */
export default function KpVersionScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { doc: docId, n: nText } = useLocalSearchParams<{ doc: string; n: string }>();
  const n = Number(nText);
  const doc = useKp((s) => s.docs[docId]);
  const sentEdits = useKp((s) => s.sentEdits);
  const held = useKp((s) => cachedVersion(docId, n, s));
  const [fetched, setFetched] = useState<KpVersionOut | null | 'loading'>('loading');
  const version = held ?? fetched;
  const [file, setFile] = useState<FileResult | 'busy' | null>(null);
  const [revert, setRevert] = useState<'unknown' | null>(null);

  useEffect(() => {
    if (!held) void loadVersion(docId, n).then(setFetched);
  }, [docId, n, held]);

  const back = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/kp/versions', params: { doc: docId } }));

  if (version === 'loading' || version === null) {
    return (
      <Screen testID="kp-version-screen">
        <View style={{ gap: theme.space[4] }}>
          <AppText variant="title1" accessibilityRole="header">
            {t('kp.version_n', { n })}
          </AppText>
          <AppText testID="kp-version-missing">{version === 'loading' ? t('kp.versions_loading') : t('kp.version_offline')}</AppText>
          <Button testID="kp-version-back" label={t('kp.back')} variant="outline" onPress={back} />
        </View>
      </Screen>
    );
  }

  const v = kpView(version.data, version, false);
  const current = doc?.current_version_n === n;
  const sent = doc ? sentVersion(doc, { sentEdits }) === n : false;
  const sentAt = version.sent_at ?? (sent ? (sentEdits[docId]?.at ?? null) : null);

  const doRevert = async () => {
    const r = await revertTo(docId, n);
    if (r === 'unknown') {
      setRevert('unknown');
      return;
    }
    router.replace({ pathname: '/kp/[id]', params: { id: docId } });
  };

  return (
    <Screen testID="kp-version-screen">
      <View style={{ gap: theme.space[4] }}>
        <Button testID="kp-version-back" label={`‹ ${t('kp.back')}`} variant="text" minHeight={theme.size.minTouch} style={{ alignSelf: 'flex-start' }} onPress={back} />
        <AppText variant="title1" accessibilityRole="header">
          {[t('kp.version_n', { n }), version.data.client.name].filter(Boolean).join(' · ')}
        </AppText>
        <AppText variant="meta">{shortDate(version.created_at, i18n.language)}</AppText>
        {sent ? (
          <View testID="kp-version-frozen" style={{ padding: theme.space[3], borderRadius: theme.radius.card, borderWidth: 2, borderColor: theme.colors.done }}>
            <AppText>{t('kp.v_frozen', { date: shortDate(sentAt, i18n.language) }).trim()}</AppText>
          </View>
        ) : null}
        <AppText testID="kp-version-total" variant="title2" style={{ fontVariant: ['tabular-nums'] }}>
          {v.totals ? t(version.data.vat.mode === 'none' ? 'kp.total' : 'kp.total_with_vat', { amount: money(v.totals.total) }) : ''}
        </AppText>
        <AppText variant="meta">{vatText(version.data.vat.mode, v.vatRate, t)}</AppText>
        <View style={{ gap: theme.space[3] }}>
          {version.data.items.map((it, i) => {
            const label = priceLabel(it, t);
            const line = v.totals?.lines[i];
            const sum = line?.amount != null ? money(line.amount) : null;
            const qty = qtyShown(it.qty);
            const unit = it.unit ?? '';
            return (
              <View
                key={it.id}
                testID={`kp-version-line-${i}`}
                accessible
                accessibilityLabel={
                  it.kind === 'lump'
                    ? t(sum ? 'kp.line_lump_a11y' : 'kp.line_lump_missing_a11y', { n: i + 1, name: it.name, volume: it.volume ?? '', sum, source: label.text })
                    : sum
                    ? t('kp.line_a11y', { n: i + 1, name: it.name, qty, unit, price: priceMoney(it.unit_price), sum, source: label.text })
                    : t('kp.line_missing_a11y', { n: i + 1, name: it.name, qty, unit })
                }
                style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.line, paddingBottom: theme.space[3], gap: theme.space[1] }}
              >
                <AppText variant="bodyStrong">{`${i + 1}. ${it.name}`}</AppText>
                {it.kind === 'lump' && it.volume ? <AppText>{t('kp.volume_line', { volume: it.volume })}</AppText> : null}
                <AppText variant="number">
                  {it.kind === 'lump'
                    ? sum
                      ? t('kp.line_lump', { sum })
                      : t('kp.line_lump_no_price')
                    : sum
                      ? t('kp.line_calc', { qty, unit, price: priceMoney(it.unit_price), sum })
                      : t('kp.line_no_price', { qty, unit })}
                </AppText>
                <AppText variant="meta">{label.text}</AppText>
              </View>
            );
          })}
        </View>
        {current ? (
          <AppText testID="kp-version-current" variant="meta">
            {t('kp.v_is_current')}
          </AppText>
        ) : (
          <Button testID="kp-version-revert" label={t('kp.v_revert')} onPress={() => void doRevert()} />
        )}
        {revert === 'unknown' ? (
          <AppText testID="kp-version-revert-offline" color="warnText" accessibilityLiveRegion="polite">
            {t('kp.version_offline')}
          </AppText>
        ) : null}
        <Button
          testID="kp-version-pdf"
          label={file === 'busy' ? t('kp.pdf_busy') : t('kp.v_pdf')}
          variant="outline"
          disabled={file === 'busy'}
          onPress={() => {
            setFile('busy');
            void shareKpFile(docId, { format: 'pdf', n, missing: v.counts.missing }).then(setFile);
          }}
        />
        {file && file !== 'busy' ? (
          <AppText testID="kp-version-pdf-result" color={file.result === 'shared' ? 'done' : 'warnText'} accessibilityLiveRegion="polite">
            {t(`kp.pdf_${file.result}`)}
          </AppText>
        ) : null}
        {version.ai_generated ? <AppText variant="meta">{t('ai.label')}</AppText> : null}
      </View>
    </Screen>
  );
}
