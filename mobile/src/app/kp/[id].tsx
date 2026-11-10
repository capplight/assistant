import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { CheckBadge } from '@/components/kp/KpParts';
import { NumberSheet } from '@/components/kp/NumberSheet';
import { ChoiceSheet } from '@/components/page/FieldSheets';
import { Screen } from '@/components/Screen';
import { StandaloneUndoStrip } from '@/components/UndoStrip';
import { priceText, qtyText } from '@/kp/calc';
import { editKp, findPrice, refreshDocument, sharePdf, type PdfResult } from '@/kp/service';
import { shownData, useKp } from '@/kp/store';
import { kpTitle, kpView, money, priceLabel, priceMoney, qtyShown, rateText, vatText } from '@/kp/view';
import { useTheme } from '@/theme';

type Editing = { item: string; field: 'unit_price' | 'qty' } | null;

/**
 * S17 «КП, шаг 2: превью и правка» (week 14). The total is counted by code (`kp/calc.ts`, the
 * port of the server's `kp/calc.py`), at once after every tap-edit, offline too. Every price shows
 * where it came from (`price_source`): «из прайса», «из КП Арману, 3 окт», «вы указали»; a line
 * with no price says «укажите цену» — nothing is made up. Each change has «Отменить». The PDF is
 * made by the server: offline the screen says so. The single «ИИ» label of the КП is at the bottom.
 */
export default function KpScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const doc = useKp((s) => s.docs[id]);
  const edits = useKp((s) => s.docEdits);
  const versions = useKp((s) => s.versions);
  const needsProfile = useKp((s) => s.needsProfile);
  const [editing, setEditing] = useState<Editing>(null);
  const [vatOpen, setVatOpen] = useState(false);
  const [pdf, setPdf] = useState<{ result: PdfResult; fields?: string[] } | 'busy' | null>(null);

  useEffect(() => {
    void refreshDocument(id);
  }, [id]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const data = doc ? shownData(id, { versions, docEdits: edits }) : null;
  if (!doc || !data) {
    return (
      <Screen testID="kp-missing">
        <AppText variant="title1">{doc ? kpTitle(doc, t) : t('kp.not_found')}</AppText>
        {doc ? <AppText testID="kp-no-version">{t('kp.no_version')}</AppText> : null}
        <Button testID="kp-back" label={t('kp.back')} variant="outline" onPress={back} />
      </Screen>
    );
  }
  const version = versions[id];
  const v = kpView(data, version, !!edits[id]);
  const totals = v.totals;
  const missing = v.counts.missing;
  const waiting = (edits[doc.id]?.rows.length ?? 0) > 0;
  const editItem = editing ? data.items.find((x) => x.id === editing.item) : undefined;
  const required = version?.missing_required.filter((f) => f !== 'total' && f !== 'amount_words') ?? [];

  const getPdf = async () => {
    setPdf('busy');
    setPdf(await sharePdf(doc.id, missing));
  };

  return (
    <View style={styles.root}>
      <Screen testID="kp-screen" edges={['top']}>
        <View style={{ gap: theme.space[4] }}>
          <View style={styles.row}>
            <Pressable
              testID="kp-back"
              accessibilityRole="button"
              accessibilityLabel={t('kp.back')}
              onPress={back}
              style={{ minHeight: theme.size.minTouch, minWidth: theme.size.minTouch, flexDirection: 'row', alignItems: 'center' }}
            >
              <ChevronLeft size={28} color={theme.colors.accent} />
              <AppText color="accent">{t('kp.back')}</AppText>
            </Pressable>
            <AppText variant="meta" style={{ marginLeft: 'auto' }}>
              {t('kp.step', { n: 2 })}
            </AppText>
          </View>
          <AppText variant="title1" accessibilityRole="header">
            {[t('kp.kp_plain'), data.client.name].filter(Boolean).join(' · ')}
          </AppText>
          <AppText testID="kp-total" variant="title2" accessibilityLiveRegion="polite" style={{ fontVariant: ['tabular-nums'] }}>
            {totals ? t(data.vat.mode === 'none' ? 'kp.total' : 'kp.total_with_vat', { amount: money(totals.total) }) : ''}
          </AppText>
          {waiting ? (
            <AppText testID="kp-waiting" variant="meta">
              {t('kp.waiting_sync')}
            </AppText>
          ) : null}
          {missing > 0 ? (
            <View style={{ gap: theme.space[2], padding: theme.space[3], backgroundColor: theme.colors.markerSoft, borderRadius: theme.radius.card }}>
              <AppText testID="kp-missing-count" color="warnText">
                {t('kp.total_missing', { count: missing })}
              </AppText>
              <Button testID="kp-fast" label={t('kp.fast_input')} variant="outline" onPress={() => router.push({ pathname: '/kp/prices', params: { doc: doc.id } })} />
            </View>
          ) : null}

          <View style={{ gap: theme.space[3] }}>
            {data.items.map((it, i) => {
              const label = priceLabel(it, t);
              const line = totals?.lines[i];
              const sum = line?.amount != null ? money(line.amount) : null;
              const qty = qtyShown(it.qty);
              const unit = it.unit ?? '';
              return (
                <View
                  key={it.id}
                  testID={`kp-line-${i}`}
                  style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.line, paddingBottom: theme.space[3], gap: theme.space[1] }}
                >
                  <View
                    accessible
                    accessibilityLabel={
                      sum
                        ? t('kp.line_a11y', { n: i + 1, name: it.name, qty, unit, price: priceMoney(it.unit_price), sum, source: label.text })
                        : t('kp.line_missing_a11y', { n: i + 1, name: it.name, qty, unit })
                    }
                  >
                    <AppText variant="bodyStrong">{`${i + 1}. ${it.name}`}</AppText>
                    <AppText variant="number" testID={`kp-line-${i}-calc`}>
                      {sum ? t('kp.line_calc', { qty, unit, price: priceMoney(it.unit_price), sum }) : t('kp.line_no_price', { qty, unit })}
                    </AppText>
                    <AppText testID={`kp-line-${i}-source`} variant="meta" color={label.kind === 'missing' || label.check ? 'warnText' : 'ink2'}>
                      {label.check ? `⚠ ${label.text}` : label.text}
                    </AppText>
                  </View>
                  {it.review_fields.length > 0 ? <CheckBadge testID={`kp-line-${i}-check`} /> : null}
                  <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
                    <Button
                      testID={`kp-line-${i}-price`}
                      label={it.unit_price === null ? t('kp.set_price') : t('kp.change_price', { price: priceMoney(it.unit_price) })}
                      accessibilityLabel={t('kp.change_price_a11y', { name: it.name })}
                      variant={it.unit_price === null ? 'primary' : 'outline'}
                      minHeight={theme.size.minTouch}
                      style={{ flexGrow: 1 }}
                      onPress={() => setEditing({ item: it.id, field: 'unit_price' })}
                    />
                    <Button
                      testID={`kp-line-${i}-qty`}
                      label={t('kp.change_qty', { qty: `${qty} ${unit}`.trim() })}
                      accessibilityLabel={t('kp.change_qty_a11y', { name: it.name })}
                      variant="outline"
                      minHeight={theme.size.minTouch}
                      style={{ flexGrow: 1 }}
                      onPress={() => setEditing({ item: it.id, field: 'qty' })}
                    />
                  </View>
                </View>
              );
            })}
          </View>

          {totals ? (
            <View testID="kp-sums" style={{ gap: theme.space[1] }}>
              {totals.discountTotal > 0n ? <SumRow label={t('kp.sum_discount', { pct: rateText(data.discount_total_pct) })} value={`−${money(totals.discountTotal)}`} /> : null}
              {data.vat.mode === 'on_top' ? <SumRow label={t('kp.sum_net')} value={money(totals.net)} /> : null}
              {data.vat.mode !== 'none' ? (
                <SumRow testID="kp-vat" label={t(data.vat.mode === 'included' ? 'kp.sum_vat_in' : 'kp.sum_vat', { rate: rateText(v.vatRate) })} value={money(totals.vat)} />
              ) : null}
              <SumRow testID="kp-sum-total" label={t('kp.sum_total')} value={money(totals.total)} strong />
            </View>
          ) : null}
          <Button
            testID="kp-vat-mode"
            label={`${t('kp.vat_line', { mode: vatText(data.vat.mode, v.vatRate, t) })} ›`}
            variant="text"
            minHeight={theme.size.minTouch}
            onPress={() => setVatOpen(true)}
          />

          {needsProfile || required.length > 0 ? (
            <View testID="kp-required" style={{ gap: theme.space[2], padding: theme.space[3], backgroundColor: theme.colors.markerSoft, borderRadius: theme.radius.card }}>
              <AppText color="warnText">{t('kp.fields_missing', { list: required.map((f) => t(`kp.req_${f.replace('.', '_')}`, { defaultValue: f })).join(', ') || t('kp.req_seller_name') })}</AppText>
              <Button testID="kp-required-company" label={t('kp.company_fill')} variant="outline" onPress={() => router.push('/company')} />
            </View>
          ) : null}
          <Button testID="kp-pdf" label={pdf === 'busy' ? t('kp.pdf_busy') : t('kp.pdf')} disabled={pdf === 'busy'} onPress={() => void getPdf()} />
          {pdf && pdf !== 'busy' ? (
            <AppText testID="kp-pdf-result" accessibilityLiveRegion="polite" color={pdf.result === 'shared' ? 'done' : 'warnText'}>
              {pdf.result === 'fields'
                ? t('kp.fields_missing', { list: (pdf.fields ?? []).map((f) => t(`kp.req_${f.replace('.', '_')}`, { defaultValue: f })).join(', ') })
                : t(`kp.pdf_${pdf.result}`)}
            </AppText>
          ) : null}
          {doc.ai_generated ? (
            <AppText testID="kp-ai-label" variant="meta">
              {t('ai.label')}
            </AppText>
          ) : null}
        </View>
      </Screen>
      <StandaloneUndoStrip />

      {editing && editItem ? (
        <NumberSheet
          testID="kp-edit"
          title={editing.field === 'unit_price' ? t('kp.edit_title_price', { name: editItem.name }) : t('kp.edit_title_qty', { name: editItem.name })}
          initial={(editing.field === 'unit_price' ? editItem.unit_price : editItem.qty) ?? ''}
          unit={editItem.unit}
          money={editing.field === 'unit_price'}
          offerList={editing.field === 'unit_price' && !findPrice(editItem.name)}
          onClose={() => setEditing(null)}
          onSave={(text, toList) => {
            const value = editing.field === 'unit_price' ? priceText(text) : qtyText(text);
            if (value === null || (editing.field === 'unit_price' && value === '0.00')) return false;
            setEditing(null);
            void editKp(doc.id, [{ item: editing.item, field: editing.field, value }], {
              strip: t('kp.price_set', { name: editItem.name }),
              savePrices: toList && editing.field === 'unit_price',
            });
            return true;
          }}
        />
      ) : null}
      {vatOpen ? (
        <ChoiceSheet
          testID="kp-vat-sheet"
          title={t('kp.vat_title')}
          options={(['included', 'on_top', 'none'] as const).map((m) => ({ key: m, label: v.vatRate ? vatText(m, v.vatRate, t) : t(`kp.vat_mode_${m}`) }))}
          value={data.vat.mode}
          onPick={(k) => {
            setVatOpen(false);
            void editKp(doc.id, [{ field: 'vat_mode', value: k as 'included' | 'on_top' | 'none' }]);
          }}
          onClose={() => setVatOpen(false)}
        />
      ) : null}
    </View>
  );
}

function SumRow({ label, value, strong = false, testID }: { label: string; value: string; strong?: boolean; testID?: string }) {
  const theme = useTheme();
  return (
    <View testID={testID} accessible accessibilityLabel={`${label}: ${value}`} style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
      <AppText variant={strong ? 'bodyStrong' : 'body'} style={{ flexGrow: 1 }}>
        {label}
      </AppText>
      <AppText variant={strong ? 'title2' : 'number'} style={{ fontVariant: ['tabular-nums'] }}>
        {value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
