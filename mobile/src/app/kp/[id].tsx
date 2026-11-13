import { router, useLocalSearchParams } from 'expo-router';
import { Ellipsis, Eye, FileDown, FileText, History, MessageSquareText, PencilLine, Plus, Send } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { KpItemOut } from '@/api/types';
import { AmountText } from '@/components/AmountText';
import { AppText } from '@/components/AppText';
import { PhraseChangeBox, PhraseLine } from '@/components/kp/KpEdits';
import { AddLineSheet, VolumeSheet } from '@/components/kp/KpLineSheets';
import { CheckBadge } from '@/components/kp/KpParts';
import { KpPreview } from '@/components/kp/KpPreview';
import { KpSendPanel } from '@/components/kp/KpSendPanel';
import { NumberSheet } from '@/components/kp/NumberSheet';
import { Sheet } from '@/components/page/ExpenseParts';
import { ChoiceSheet } from '@/components/page/FieldSheets';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/ui/Button';
import { Card, ListGroup, ListRow } from '@/components/ui/Card';
import { Header } from '@/components/ui/Header';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ActionList } from '@/components/ui/Sheet';
import { StandaloneUndoStrip } from '@/components/UndoStrip';
import { priceText, qtyText } from '@/kp/calc';
import { addKpLine, assistantOn, editKp, findPrice, refreshDocument, shareKpFile, shownStatus, type PdfResult } from '@/kp/service';
import { cachedVersion, sentVersion, shownData, useKp } from '@/kp/store';
import { kpTitle, kpView, money, priceLabel, priceMoney, qtyShown, rateText, shortDate, statusWord, vatText, type KpView } from '@/kp/view';
import { useLayout, useTheme } from '@/theme';

type Editing = { item: string; field: 'unit_price' | 'qty' } | null;
type Mode = 'edit' | 'preview';

/** 2-design `motion`: a changed line is lit for 600 ms (R-30). */
const HIGHLIGHT_MS = 600;
/** The bottom bar «Итого + Отправить» (research pattern 7: 72 pt). */
const BAR_MIN = 72;

/** `/items/i3/unit_price`, `/items/i3` → `i3`: the lines a version changed. */
const NONE = new Set<string>();
const changedLines = (paths: readonly string[]) => new Set(paths.flatMap((p) => /^\/items\/([^/]+)/.exec(p)?.[1] ?? []));

/**
 * S17 «КП: редактор» (research patterns 7–8, screens.html «КП: редактор»). The client, the lines as compact rows
 * (name, «48 м² × 4 500 ₸», the sum on the right; a tap opens the line's sheet with the price and the quantity),
 * «＋ Позиция» as the last row, the sums, and a pinned bar «Итого + Отправить». «Правка | Просмотр» shows the
 * КП as an A4 sheet; at ≥840 the sheet stays beside the editor. PDF, Word and the versions live in «⋯». The
 * total is counted by code (`kp/calc.ts`, the port of the server's `kp/calc.py`) at once after every tap-edit,
 * offline too. Every price shows where it came from; a line with no price says «укажите цену» — nothing is made
 * up. Each change has «Отменить». Sending is one confirmation sheet. The single «ИИ» label is at the end.
 */
export default function KpScreen() {
  const theme = useTheme();
  const layout = useLayout();
  const { t, i18n } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const doc = useKp((s) => s.docs[id]);
  const edits = useKp((s) => s.docEdits);
  const versions = useKp((s) => s.versions);
  const needsProfile = useKp((s) => s.needsProfile);
  const status = useKp((s) => (s.docs[id] ? shownStatus(s.docs[id]!, s.statusEdits, s.sentEdits) : 'draft'));
  const [editing, setEditing] = useState<Editing>(null);
  const [lineFor, setLineFor] = useState<string | null>(null);
  const [vatOpen, setVatOpen] = useState(false);
  const [pdf, setPdf] = useState<{ result: PdfResult; fields?: string[]; format: 'pdf' | 'docx' } | 'busy' | null>(null);
  const [more, setMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<Mode>('edit');
  const [volumeFor, setVolumeFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const change = useKp((s) => s.phraseChanges[id]);
  const oldVersions = useKp((s) => s.oldVersions);
  const sentEdits = useKp((s) => s.sentEdits);
  const history = useKp((s) => s.history[id]);
  // The version whose 600 ms are over.
  const [litDone, setLitDone] = useState<number | null>(null);

  useEffect(() => {
    void refreshDocument(id);
  }, [id]);

  // The lines the phrase changed are lit for 600 ms, once, when its version arrives.
  const changeN = change?.n;
  useEffect(() => {
    if (!changeN) return;
    const timer = setTimeout(() => setLitDone(changeN), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [changeN]);
  const lit = change && litDone !== change.n ? changedLines(change.changedPaths) : NONE;

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const data = doc ? shownData(id, { versions, docEdits: edits }) : null;
  if (!doc || !data) {
    return (
      <Screen testID="kp-missing">
        <Header title={doc ? kpTitle(doc, t) : t('kp.not_found')} back={{ onPress: back, testID: 'kp-back', label: t('kp.back') }} />
        {doc ? <AppText testID="kp-no-version">{t('kp.no_version')}</AppText> : null}
      </Screen>
    );
  }
  const version = versions[id];
  const v = kpView(data, version, !!edits[id]);
  const totals = v.totals;
  const missing = v.counts.missing;
  const waiting = (edits[doc.id]?.rows.length ?? 0) > 0;
  const editItem = editing ? data.items.find((x) => x.id === editing.item) : undefined;
  const lineIndex = lineFor ? data.items.findIndex((x) => x.id === lineFor) : -1;
  const required = version?.missing_required.filter((f) => f !== 'total' && f !== 'amount_words') ?? [];

  const getFile = async (format: 'pdf' | 'docx') => {
    setMore(false);
    setPdf('busy');
    setPdf({ ...(await shareKpFile(doc.id, { format, missing })), format });
  };
  const sentN = sentVersion(doc, { sentEdits });
  const sentAt = version && sentN === version.n ? (sentEdits[doc.id]?.at ?? version.sent_at) : null;
  const versionCount = Math.max(history?.versions.length ?? 0, doc.current_version_n ?? version?.n ?? 1);
  const before = change ? (cachedVersion(doc.id, change.beforeN, { versions, oldVersions })?.data ?? null) : null;
  const totalText = totals ? t(data.vat.mode === 'none' ? 'kp.total' : 'kp.total_with_vat', { amount: money(totals.total) }) : '';
  const versionLine = version
    ? sentAt
      ? t('kp.version_sent', { n: version.n, date: shortDate(sentAt, i18n.language) })
      : sentN !== null && version.n > sentN
        ? t('kp.version_after_sent', { n: version.n, sent: sentN })
        : t('kp.version_n', { n: version.n })
    : null;

  const two = layout.twoPane;
  // The sheet beside the editor at ≥840: the editor keeps its readable 600, the sheet takes the rest (≤ A4 at 480).
  const sheetWidth = two
    ? Math.min(480, layout.width - layout.insets.left - layout.insets.right - layout.gutter * 3 - Math.min(600, layout.width * 0.55))
    : Math.min(layout.contentWidth, 600);

  const editor = (
    <View testID="kp-editor" style={{ gap: theme.space[4] }}>
      {data.client.name || data.client.contact ? (
        <ListGroup testID="kp-client">
          <ListRow
            left={<Initials name={data.client.name ?? data.client.contact ?? ''} />}
            title={data.client.name ?? t('send.no_client')}
            meta={data.client.contact ?? undefined}
          />
        </ListGroup>
      ) : null}
      {change && change.n === version?.n && !waiting ? <PhraseChangeBox docId={doc.id} change={change} before={before} after={data} /> : null}
      {waiting ? (
        <AppText testID="kp-waiting" variant="callout">
          {t('kp.waiting_sync')}
        </AppText>
      ) : null}
      {missing > 0 ? (
        <Card tone="sunken">
          <View style={{ gap: theme.space[2] }}>
            <AppText testID="kp-missing-count" color="warning">
              {t('kp.total_missing', { count: missing })}
            </AppText>
            <Button testID="kp-fast" label={t('kp.fast_input')} variant="secondary" onPress={() => router.push({ pathname: '/kp/prices', params: { doc: doc.id } })} />
          </View>
        </Card>
      ) : null}

      <View style={{ gap: theme.space[2] }}>
        <View style={[styles.row, { paddingHorizontal: theme.space[1] }]}>
          <AppText variant="sectionLabel" accessibilityRole="header" style={styles.flex}>
            {t('kp.lines')}
          </AppText>
          <AppText variant="callout">{String(data.items.length)}</AppText>
        </View>
        <Card padded={false} style={styles.clip}>
          {data.items.map((it, i) => (
            <LineRow key={it.id} it={it} i={i} v={v} lit={lit.has(it.id)} onPress={() => setLineFor(it.id)} />
          ))}
          <Pressable
            testID="kp-add-line"
            accessibilityRole="button"
            accessibilityLabel={t('kp.add_line')}
            onPress={() => setAdding(true)}
            style={({ pressed }) => [styles.row, { gap: theme.space[2], minHeight: theme.size.rowHeight, paddingHorizontal: theme.space[3] + 2 }, pressed ? { backgroundColor: theme.colors.surfaceSunken } : null]}
          >
            <Icon icon={Plus} size="sm" color="brand" />
            <AppText color="brand" style={{ fontFamily: theme.type.sectionLabel.fontFamily }}>
              {t('kp.add_line_row')}
            </AppText>
          </Pressable>
        </Card>
      </View>

      {totals ? (
        <Card testID="kp-sums">
          <View style={{ gap: theme.space[1] }}>
            {totals.discountTotal > 0n ? <SumRow label={t('kp.sum_discount', { pct: rateText(data.discount_total_pct) })} value={`−${money(totals.discountTotal)}`} /> : null}
            {data.vat.mode === 'on_top' ? <SumRow label={t('kp.sum_net')} value={money(totals.net)} /> : null}
            {data.vat.mode !== 'none' ? (
              <SumRow testID="kp-vat" label={t(data.vat.mode === 'included' ? 'kp.sum_vat_in' : 'kp.sum_vat', { rate: rateText(v.vatRate) })} value={money(totals.vat)} />
            ) : null}
            <SumRow testID="kp-sum-total" label={t(data.vat.mode === 'none' ? 'kp.sum_total_no_vat' : 'kp.sum_total')} value={money(totals.total)} strong />
          </View>
        </Card>
      ) : null}
      <ListGroup>
        <ListRow testID="kp-vat-mode" title={t('kp.vat_line', { mode: vatText(data.vat.mode, v.vatRate, t) })} chevron onPress={() => setVatOpen(true)} />
      </ListGroup>

      {needsProfile || required.length > 0 ? (
        <Card testID="kp-required" tone="sunken">
          <View style={{ gap: theme.space[2] }}>
            <AppText color="warning">
              {t('kp.fields_missing', { list: required.map((f) => t(`kp.req_${f.replace('.', '_')}`, { defaultValue: f })).join(', ') || t('kp.req_seller_name') })}
            </AppText>
            <Button testID="kp-required-company" label={t('kp.company_fill')} variant="secondary" onPress={() => router.push('/company')} />
          </View>
        </Card>
      ) : null}
      <PhraseLine docId={doc.id} assistant={assistantOn()} />
      {pdf && pdf !== 'busy' ? (
        <AppText testID="kp-pdf-result" accessibilityLiveRegion="polite" color={pdf.result === 'shared' ? 'success' : 'warning'}>
          {pdf.result === 'fields'
            ? t('kp.fields_missing', { list: (pdf.fields ?? []).map((f) => t(`kp.req_${f.replace('.', '_')}`, { defaultValue: f })).join(', ') })
            : pdf.result === 'shared' && pdf.format === 'docx'
              ? t('kp.docx_shared')
              : t(`kp.pdf_${pdf.result}`)}
        </AppText>
      ) : pdf === 'busy' ? (
        <AppText testID="kp-pdf-busy" variant="callout" accessibilityLiveRegion="polite">
          {t('kp.pdf_busy')}
        </AppText>
      ) : null}
      {doc.ai_generated ? (
        <AppText testID="kp-ai-label" variant="footnote">
          {t('ai.label')}
        </AppText>
      ) : null}
    </View>
  );

  const preview = (
    <View testID="kp-preview-pane" style={{ alignItems: 'center', gap: theme.space[2] }}>
      <KpPreview doc={doc} view={v} width={sheetWidth} />
      <AppText variant="footnote" style={{ textAlign: 'center' }}>
        {t('kp.preview_note')}
      </AppText>
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <SafeAreaView testID="kp-screen" edges={['top']} style={styles.root}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: layout.gutter, paddingTop: theme.space[2], paddingBottom: theme.space[6], alignItems: 'center' }}>
          <View style={{ width: '100%', maxWidth: two ? 600 + sheetWidth + layout.gutter : 600, gap: theme.space[3] }}>
            <Header
              title={kpTitle(doc, t)}
              meta={statusWord(status, t)}
              back={{ onPress: back, testID: 'kp-back', label: t('kp.back') }}
              actions={[{ key: 'more', testID: 'kp-more', icon: Ellipsis, label: t('kp.more'), onPress: () => setMore(true) }]}
            >
              {two ? null : (
                <SegmentedControl
                  testID="kp-mode"
                  accessibilityLabel={t('kp.mode_a11y')}
                  segments={[
                    { key: 'edit' as const, label: t('kp.mode_edit'), testID: 'kp-mode-edit' },
                    { key: 'preview' as const, label: t('kp.mode_preview'), testID: 'kp-mode-preview' },
                  ]}
                  value={mode}
                  onChange={setMode}
                />
              )}
            </Header>
            {versionLine ? (
              <AppText testID="kp-version-line" variant="footnote">
                {versionLine}
              </AppText>
            ) : null}
            {two ? (
              <View style={[styles.top, { gap: layout.gutter }]}>
                <View style={{ flex: 1, maxWidth: 600 }}>{editor}</View>
                <View style={{ width: sheetWidth }}>{preview}</View>
              </View>
            ) : mode === 'edit' ? (
              editor
            ) : (
              preview
            )}
          </View>
        </ScrollView>
        <TotalBar
          text={totalText}
          amount={totals ? money(totals.total) : '—'}
          label={t(data.vat.mode === 'none' ? 'kp.bar_total' : 'kp.bar_total_vat')}
          mode={mode}
          showPreviewToggle={!two}
          onToggle={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
          onSend={() => setSending(true)}
        />
      </SafeAreaView>
      <StandaloneUndoStrip />

      {lineFor && lineIndex >= 0 ? (
        <LineSheet
          it={data.items[lineIndex]!}
          i={lineIndex}
          v={v}
          onClose={() => setLineFor(null)}
          onPrice={() => (setLineFor(null), setEditing({ item: lineFor, field: 'unit_price' }))}
          onQty={() => (setLineFor(null), setEditing({ item: lineFor, field: 'qty' }))}
          onVolume={() => (setLineFor(null), setVolumeFor(lineFor))}
        />
      ) : null}
      {editing && editItem ? (
        <NumberSheet
          testID="kp-edit"
          title={
            editing.field === 'unit_price'
              ? t(editItem.kind === 'lump' ? 'kp.edit_title_amount' : 'kp.edit_title_price', { name: editItem.name })
              : t('kp.edit_title_qty', { name: editItem.name })
          }
          initial={(editing.field === 'unit_price' ? editItem.unit_price : editItem.qty) ?? ''}
          unit={editItem.unit}
          money={editing.field === 'unit_price'}
          offerList={editing.field === 'unit_price' && editItem.kind !== 'lump' && !findPrice(editItem.name)}
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
      {volumeFor && data.items.find((x) => x.id === volumeFor) ? (
        <VolumeSheet
          name={data.items.find((x) => x.id === volumeFor)!.name}
          initial={data.items.find((x) => x.id === volumeFor)!.volume ?? ''}
          onClose={() => setVolumeFor(null)}
          onSave={(value) => {
            const lineId = volumeFor;
            setVolumeFor(null);
            void editKp(doc.id, [{ item: lineId, field: 'volume', value }], { strip: t('kp.volume_set') });
          }}
        />
      ) : null}
      {adding ? (
        <AddLineSheet
          defaultKind={data.items.some((x) => x.kind === 'lump') || data.items.length === 0 ? 'lump' : 'qty'}
          onClose={() => setAdding(false)}
          onSave={(l) => {
            setAdding(false);
            void addKpLine(doc.id, l);
            return true;
          }}
        />
      ) : null}
      {more ? (
        <Sheet testID="kp-more-sheet" title={t('kp.more')} onClose={() => setMore(false)}>
          <ActionList
            actions={[
              { key: 'pdf', testID: 'kp-pdf', icon: FileDown, label: t('kp.pdf'), disabled: pdf === 'busy', onPress: () => void getFile('pdf') },
              { key: 'docx', testID: 'kp-docx', icon: FileText, label: t('kp.docx'), disabled: pdf === 'busy', onPress: () => void getFile('docx') },
              {
                key: 'versions',
                testID: 'kp-versions',
                icon: History,
                label: t('kp.versions', { count: versionCount }),
                onPress: () => (setMore(false), router.push({ pathname: '/kp/versions', params: { doc: doc.id } })),
              },
              {
                key: 'write',
                testID: 'kp-write',
                icon: MessageSquareText,
                label: t('draft.write_client'),
                onPress: () => (setMore(false), router.push({ pathname: '/draft/new', params: { doc: doc.id } })),
              },
            ]}
          />
        </Sheet>
      ) : null}
      {sending ? (
        <Sheet testID="kp-send-sheet" title={t('send.title')} onClose={() => setSending(false)}>
          <KpSendPanel docId={doc.id} onDone={() => setSending(false)} />
        </Sheet>
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

/** The meta line of a line row: «48 м² × 4 500 ₸», «4 шт × ?», «Объём: 1 здание». */
function lineMeta(it: KpItemOut, sum: string | null, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (it.kind === 'lump') return it.volume ? t('kp.volume_line', { volume: it.volume }) : t('kp.lump_word');
  const qty = qtyShown(it.qty);
  const unit = it.unit ?? '';
  return sum ? t('kp.line_short', { qty, unit, price: priceMoney(it.unit_price) }).replace(/\s+×/, ' ×').replace(/\s{2,}/g, ' ') : t('kp.line_no_price', { qty, unit });
}

function lineA11y(it: KpItemOut, i: number, sum: string | null, source: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const qty = qtyShown(it.qty);
  const unit = it.unit ?? '';
  const volume = it.volume ?? '';
  if (it.kind === 'lump')
    return sum ? t('kp.line_lump_a11y', { n: i + 1, name: it.name, volume, sum, source }) : t('kp.line_lump_missing_a11y', { n: i + 1, name: it.name, volume });
  return sum ? t('kp.line_a11y', { n: i + 1, name: it.name, qty, unit, price: priceMoney(it.unit_price), sum, source }) : t('kp.line_missing_a11y', { n: i + 1, name: it.name, qty, unit });
}

/** Pattern 7: one line = one row 60–64: the name 17, «12 м² × 4 500 ₸» 15, the sum on the right. */
function LineRow({ it, i, v, lit, onPress }: { it: KpItemOut; i: number; v: KpView; lit: boolean; onPress: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const label = priceLabel(it, t);
  const line = v.totals?.lines[i];
  const sum = line?.amount != null ? money(line.amount) : null;
  const warn = label.kind === 'missing' || label.check;
  const lump = it.kind === 'lump';
  return (
    <Pressable
      testID={`kp-line-${i}`}
      accessibilityRole="button"
      accessibilityLabel={lineA11y(it, i, sum, label.text, t)}
      accessibilityHint={t('kp.line_hint')}
      onPress={onPress}
      style={({ pressed }) => [{ paddingLeft: theme.space[3] + 2, backgroundColor: lit ? theme.colors.highlightTint : pressed ? theme.colors.surfaceSunken : 'transparent' }]}
    >
      <View
        style={[
          styles.row,
          { gap: theme.space[2], minHeight: 62, paddingVertical: theme.space[2], paddingRight: theme.space[3], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.separator },
          theme.largeFont ? { flexWrap: 'wrap' } : null,
        ]}
      >
        <View style={[styles.flex, { minWidth: theme.largeFont ? '60%' : undefined }]}>
          <AppText>{it.name}</AppText>
          <AppText testID={lump ? `kp-line-${i}-volume` : `kp-line-${i}-calc`} variant="callout" style={styles.tabular}>
            {lineMeta(it, sum, t)}
          </AppText>
          {warn ? (
            <AppText testID={`kp-line-${i}-source`} variant="footnote" color="warning">
              {label.check ? `⚠ ${label.text}` : label.text}
            </AppText>
          ) : null}
          {it.review_fields.length > 0 ? <CheckBadge testID={`kp-line-${i}-check`} /> : null}
        </View>
        <AppText testID={`kp-line-${i}-sum`} variant="bodyStrong" color={sum ? 'ink' : 'warning'} style={styles.tabular}>
          {sum ?? t('kp.sum_none')}
        </AppText>
      </View>
    </Pressable>
  );
}

/** A tap on a line: its calculation, where the price came from, then «Цена ›» and «Кол-во ›» (or «Объём ›»). */
function LineSheet({
  it,
  i,
  v,
  onClose,
  onPrice,
  onQty,
  onVolume,
}: {
  it: KpItemOut;
  i: number;
  v: KpView;
  onClose: () => void;
  onPrice: () => void;
  onQty: () => void;
  onVolume: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const label = priceLabel(it, t);
  const line = v.totals?.lines[i];
  const sum = line?.amount != null ? money(line.amount) : null;
  const qty = qtyShown(it.qty);
  const unit = it.unit ?? '';
  const lump = it.kind === 'lump';
  const volume = it.volume ?? '';
  // A line added here and not on the server yet: its id is the phone's, edits wait for it.
  const pendingLine = it.id.startsWith('new-');
  return (
    <Sheet testID="kp-line-sheet" title={`${i + 1}. ${it.name}`} onClose={onClose}>
      <View style={{ gap: theme.space[1] }}>
        <AppText testID="kp-line-sheet-calc" variant="number">
          {lump
            ? sum
              ? t('kp.line_lump', { sum })
              : t('kp.line_lump_no_price')
            : sum
              ? t('kp.line_calc', { qty, unit, price: priceMoney(it.unit_price), sum })
              : t('kp.line_no_price', { qty, unit })}
        </AppText>
        <AppText testID="kp-line-sheet-source" variant="callout" color={label.kind === 'missing' || label.check ? 'warning' : 'ink2'}>
          {label.check ? `⚠ ${label.text}` : label.text}
        </AppText>
        {it.review_fields.length > 0 ? <CheckBadge /> : null}
        {pendingLine ? <AppText variant="footnote">{t('kp.waiting_sync')}</AppText> : null}
      </View>
      <ListGroup>
        <ListRow
          testID={`kp-line-${i}-price`}
          title={it.unit_price === null ? t(lump ? 'kp.set_amount' : 'kp.set_price') : t(lump ? 'kp.change_amount' : 'kp.change_price', { price: priceMoney(it.unit_price) })}
          accessibilityLabel={t(lump ? 'kp.change_amount_a11y' : 'kp.change_price_a11y', { name: it.name })}
          icon={PencilLine}
          chevron
          disabled={pendingLine}
          onPress={onPrice}
        />
        {lump ? (
          <ListRow
            testID={`kp-line-${i}-volume-edit`}
            title={volume ? t('kp.change_volume', { volume }) : t('kp.set_volume')}
            accessibilityLabel={t('kp.change_volume_a11y', { name: it.name })}
            icon={PencilLine}
            chevron
            disabled={pendingLine}
            onPress={onVolume}
          />
        ) : (
          <ListRow
            testID={`kp-line-${i}-qty`}
            title={t('kp.change_qty', { qty: `${qty} ${unit}`.trim() })}
            accessibilityLabel={t('kp.change_qty_a11y', { name: it.name })}
            icon={PencilLine}
            chevron
            disabled={pendingLine}
            onPress={onQty}
          />
        )}
      </ListGroup>
    </Sheet>
  );
}

/** Pattern 7: the pinned bar — «Итого» and the sum, «Отправить»; «Просмотр» as a round button on the left. */
function TotalBar({
  text,
  amount,
  label,
  mode,
  showPreviewToggle,
  onToggle,
  onSend,
}: {
  text: string;
  amount: string;
  label: string;
  mode: Mode;
  showPreviewToggle: boolean;
  onToggle: () => void;
  onSend: () => void;
}) {
  const theme = useTheme();
  const layout = useLayout();
  const { t } = useTranslation();
  const toggle = mode === 'edit' ? t('kp.mode_preview') : t('kp.mode_edit');
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderTopLeftRadius: theme.radius.xl,
          borderTopRightRadius: theme.radius.xl,
          paddingHorizontal: layout.gutter,
          paddingTop: theme.space[3],
          paddingBottom: theme.space[3] + layout.insets.bottom,
          alignItems: 'center',
        },
        theme.elevation.floating,
      ]}
    >
      <View style={[styles.row, { width: '100%', maxWidth: 600, gap: theme.space[3], minHeight: BAR_MIN - theme.space[3] * 2, flexWrap: theme.largeFont ? 'wrap' : 'nowrap' }]}>
        {showPreviewToggle ? (
          <Pressable
            testID="kp-bar-toggle"
            accessibilityRole="button"
            accessibilityLabel={toggle}
            onPress={onToggle}
            style={{ width: theme.size.minTouch, height: theme.size.minTouch, borderRadius: theme.size.minTouch / 2, backgroundColor: theme.colors.brandTint, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon icon={mode === 'edit' ? Eye : PencilLine} size="sm" color="brand" />
          </Pressable>
        ) : null}
        <View testID="kp-total" accessible accessibilityLabel={text} accessibilityLiveRegion="polite" style={[styles.flex, { minWidth: theme.largeFont ? '60%' : undefined }]}>
          <AppText variant="footnote">{label}</AppText>
          <AmountText testID="kp-total-amount" variant="title2" inset={layout.gutter * 2 + 48 + 140 + theme.space[3] * 2}>
            {amount}
          </AmountText>
        </View>
        <Button testID="kp-send" label={t('send.open')} icon={<Icon icon={Send} size="sm" color="onBrand" />} style={theme.largeFont ? { flexBasis: '100%' } : undefined} onPress={onSend} />
      </View>
    </View>
  );
}

function Initials({ name }: { name: string }) {
  const theme = useTheme();
  const letters =
    name
      .replace(/[«»"'()]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !/^(ТОО|ИП|АО|ООО|LLP)$/i.test(w))
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '•';
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ width: 32, height: 32, borderRadius: theme.radius.sm, backgroundColor: theme.colors.brandTint, alignItems: 'center', justifyContent: 'center' }}
    >
      <AppText variant="footnote" color="brand" style={{ fontFamily: theme.type.sectionLabel.fontFamily }}>
        {letters}
      </AppText>
    </View>
  );
}

function SumRow({ label, value, strong = false, testID }: { label: string; value: string; strong?: boolean; testID?: string }) {
  const theme = useTheme();
  return (
    <View testID={testID} accessible accessibilityLabel={`${label}: ${value}`} style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
      <AppText variant={strong ? 'bodyStrong' : 'callout'} color={strong ? 'ink' : 'ink2'} style={{ flexGrow: 1 }}>
        {label}
      </AppText>
      <AmountText variant={strong ? 'title2' : 'number'} inset={theme.screenPadding * 2 + theme.space[4] * 2}>
        {value}
      </AmountText>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  top: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
  clip: { overflow: 'hidden' },
  tabular: { fontVariant: ['tabular-nums'] },
});
