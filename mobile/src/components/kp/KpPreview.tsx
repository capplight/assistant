import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';

import type { DocumentOut } from '@/api/types';
import { shownProfile, useKp } from '@/kp/store';
import { kpTitle, money, priceMoney, qtyShown, rateText, shortDate, type KpView } from '@/kp/view';
import { fontFamily, useTheme } from '@/theme';

/** A4 portrait: 210 × 297. The page is drawn in its own points (595 wide) and scaled to the given width. */
export const A4_RATIO = 297 / 210;
const PAGE_PT = 595;
/** Paper is paper in both themes: white with dark ink (the client gets this sheet). */
const PAPER = '#FFFFFF';
const INK = '#1A1A1A';
const INK2 = '#5B5B5B';
const RULE = '#D9D9D9';

/**
 * «Просмотр» (research pattern 8): the КП as a sheet of A4 drawn from the same view model as the editor (the
 * numbers come from `kp/calc.ts` / the server's totals, nothing is counted here). The server's PDF stays the
 * document that is sent; this is its picture, so its text does not grow with the system font — the page is
 * one accessible element with a spoken summary, and the editor holds the real, scalable text. The single «ИИ»
 * label of the КП stays on the screen (`kp-ai-label`), not duplicated on the picture.
 */
export function KpPreview({ doc, view, width, testID = 'kp-preview' }: { doc: DocumentOut; view: KpView; width: number; testID?: string }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const base = useKp((s) => s.profile);
  const edit = useKp((s) => s.profileEdit);
  const profile = useMemo(() => shownProfile({ profile: base, profileEdit: edit }), [base, edit]);
  const k = width / PAGE_PT;
  const fs = (pt: number, extra?: TextStyle): TextStyle => ({ fontSize: pt * k, lineHeight: pt * k * 1.35, color: INK, fontFamily: fontFamily.regular, ...extra });
  const bold = (pt: number, extra?: TextStyle) => fs(pt, { fontFamily: fontFamily.semibold, ...extra });
  const { data, totals } = view;
  const title = kpTitle(doc, t);
  const date = shortDate(data.date ?? doc.date ?? doc.created_at, i18n.language);
  const total = totals ? money(totals.total) : '';
  const seller = [profile.legal_form, profile.name].filter(Boolean).join(' ') || t('kp.preview_seller');
  const sellerMeta = [profile.bin_iin ? t('kp.preview_bin', { bin: profile.bin_iin }) : null, profile.address, profile.phone].filter(Boolean).join(' · ');
  const pad = 40 * k;
  const col = { n: 22 * k, qty: 70 * k, price: 86 * k, sum: 92 * k };
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t('kp.preview_a11y', { title, client: data.client.name ?? t('send.no_client'), total, count: data.items.length })}
      style={[{ width, aspectRatio: 1 / A4_RATIO, backgroundColor: PAPER, borderRadius: 4 }, theme.elevation.floating]}
    >
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ flex: 1, padding: pad, gap: 10 * k, overflow: 'hidden' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 * k }}>
          <View style={{ flex: 1 }}>
            <T style={bold(11)}>{seller}</T>
            {sellerMeta ? <T style={fs(8, { color: INK2 })}>{sellerMeta}</T> : null}
          </View>
          <T style={fs(8, { color: INK2, textAlign: 'right' })}>{date}</T>
        </View>
        <View style={{ height: 1, backgroundColor: RULE }} />
        <T style={bold(16)}>{title}</T>
        {data.subject ? <T style={fs(9)}>{data.subject}</T> : null}
        {data.client.name ? <T style={fs(9)}>{t('kp.preview_to', { name: data.client.name })}</T> : null}
        <View style={{ marginTop: 6 * k }}>
          <View style={[styles.tr, { borderBottomWidth: 1, borderColor: INK, paddingVertical: 4 * k, gap: 4 * k }]}>
            <T style={bold(7.5, { width: col.n })}>№</T>
            <T style={bold(7.5, { flex: 1 })}>{t('kp.preview_col_name')}</T>
            <T style={bold(7.5, { width: col.qty, textAlign: 'right' })}>{t('kp.preview_col_qty')}</T>
            <T style={bold(7.5, { width: col.price, textAlign: 'right' })}>{t('kp.preview_col_price')}</T>
            <T style={bold(7.5, { width: col.sum, textAlign: 'right' })}>{t('kp.preview_col_sum')}</T>
          </View>
          {data.items.map((it, i) => {
            const line = totals?.lines[i];
            const sum = line?.amount != null ? money(line.amount) : '—';
            const lump = it.kind === 'lump';
            return (
              <View key={it.id} style={[styles.tr, { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: RULE, paddingVertical: 4 * k, gap: 4 * k }]}>
                <T style={fs(7.5, { width: col.n })}>{String(i + 1)}</T>
                <T style={fs(7.5, { flex: 1 })}>{it.name}</T>
                <T style={fs(7.5, { width: col.qty, textAlign: 'right' })}>{lump ? (it.volume ?? '') : `${qtyShown(it.qty)} ${it.unit ?? ''}`.trim()}</T>
                <T style={fs(7.5, { width: col.price, textAlign: 'right' })}>{lump ? '' : priceMoney(it.unit_price) || '—'}</T>
                <T style={fs(7.5, { width: col.sum, textAlign: 'right' })}>{sum}</T>
              </View>
            );
          })}
        </View>
        {totals ? (
          <View style={{ alignSelf: 'flex-end', gap: 2 * k, minWidth: 200 * k }}>
            {totals.discountTotal > 0n ? <Sum k={k} label={t('kp.sum_discount', { pct: rateText(data.discount_total_pct) })} value={`−${money(totals.discountTotal)}`} /> : null}
            {data.vat.mode !== 'none' ? (
              <Sum k={k} label={t(data.vat.mode === 'included' ? 'kp.sum_vat_in' : 'kp.sum_vat', { rate: rateText(view.vatRate) })} value={money(totals.vat)} />
            ) : null}
            <Sum k={k} label={t(data.vat.mode === 'none' ? 'kp.sum_total_no_vat' : 'kp.sum_total')} value={total} strong />
          </View>
        ) : null}
        {data.conditions.length > 0 ? (
          <View style={{ gap: 2 * k }}>
            {data.conditions.map((c, i) => (
              <T key={i} style={fs(7.5, { color: INK2 })}>{`• ${c}`}</T>
            ))}
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        {profile.signer_name ? <T style={fs(8)}>{[profile.signer_title, profile.signer_name].filter(Boolean).join(' ')}</T> : null}
      </View>
    </View>
  );
}

function Sum({ k, label, value, strong = false }: { k: number; label: string; value: string; strong?: boolean }) {
  const size = (strong ? 9 : 7.5) * k;
  const style: TextStyle = { fontSize: size, lineHeight: size * 1.35, color: strong ? INK : INK2, fontFamily: strong ? fontFamily.semibold : fontFamily.regular };
  return (
    <View style={[styles.tr, { justifyContent: 'space-between', gap: 8 * k }]}>
      <Text allowFontScaling={false} style={style}>
        {label}
      </Text>
      <Text allowFontScaling={false} style={[style, { fontVariant: ['tabular-nums'] }]}>
        {value}
      </Text>
    </View>
  );
}

/** Paper text: drawn at the sheet's scale, it does not follow the system font (the editor does). */
function T({ style, children }: { style: TextStyle; children: string }) {
  return (
    <Text allowFontScaling={false} style={style}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  tr: { flexDirection: 'row', alignItems: 'flex-start' },
});
