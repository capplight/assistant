import { router } from 'expo-router';
import { AlertCircle, Camera, ChevronRight, FileText, Image as ImageIcon, QrCode, Share2 } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import type { ExpenseDuplicateOut, ExpenseOut, StatementOut } from '@/api/types';
import { formatAmount } from '@/expenses/calc';
import { dayLabel, lineTitle, planTitle } from '@/expenses/feed';
import { dismissDuplicate, dismissJob, mergeDuplicate, planNumbers, qrPreview, type PlanResult } from '@/expenses/receipts';
import { useExpenses, type ReceiptJob } from '@/expenses/store';
import { useConnectivity } from '@/store/connectivity';
import { useFeatures } from '@/store/features';
import { useToast } from '@/store/toast';
import { useTheme, withAlpha } from '@/theme';

import { AmountText } from '../AmountText';
import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { pressedStyle } from '../ui/motion';
import { Sheet } from './ExpenseParts';

/** Where a spending came from, in words (never only an icon). */
export function sourceWord(source: string, t: (k: string) => string): string | null {
  switch (source) {
    case 'receipt_ocr':
    case 'shared_receipt':
      return t('exp.src_receipt');
    case 'receipt_qr':
      return t('exp.src_qr');
    case 'statement_pdf':
      return t('exp.src_statement');
    case 'voice':
      return t('exp.src_voice');
    default:
      return null;
  }
}

/** Ф-37: statements PDF and receipt QR stay in the code, hidden while their switches are off. */
export function useBringKinds() {
  const statements = useFeatures((f) => f.statements_pdf);
  const qr = useFeatures((f) => f.receipt_qr);
  return { statements, qr };
}

/**
 * «Чек»: a tonal button, then a sheet of plain rows (52 pt) — camera, gallery and, when their switches are on,
 * QR and a bank statement (with how to bring one from Kaspi). Each opens the receipt screen, which explains the
 * camera before asking.
 */
export function BringButton({ pageId, style }: { pageId: string; style?: object }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const kinds = useBringKinds();
  const [open, setOpen] = useState(false);
  const go = (kind: string) => {
    setOpen(false);
    router.push({ pathname: '/receipt', params: { kind, page: pageId } });
  };
  const rows = [
    { kind: 'camera', label: t('exp.bring_camera'), Ico: Camera },
    { kind: 'photo', label: t('exp.bring_photo'), Ico: ImageIcon },
    ...(kinds.qr ? [{ kind: 'qr', label: t('exp.bring_qr'), Ico: QrCode }] : []),
    ...(kinds.statements ? [{ kind: 'statement', label: t('exp.bring_statement'), Ico: FileText }] : []),
  ];
  return (
    <>
      <Button
        testID="exp-bring"
        label={kinds.statements ? t('exp.bring') : t('exp.bring_receipt')}
        variant="secondary"
        icon={<Icon icon={Camera} size="sm" color="brand" />}
        style={style}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <Sheet testID="exp-bring-sheet" title={kinds.statements ? t('exp.bring_title') : t('exp.bring_receipt')} onClose={() => setOpen(false)}>
          <View>
            {rows.map(({ kind, label, Ico }, i) => (
              <Pressable
                key={kind}
                testID={`exp-bring-${kind}`}
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => go(kind)}
                style={({ pressed }) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.space[3],
                    minHeight: theme.size.rowHeight,
                    borderBottomWidth: i < rows.length - 1 ? 0.5 : 0,
                    borderBottomColor: theme.colors.separator,
                  },
                  pressedStyle(pressed),
                ]}
              >
                <View style={{ width: 30, height: 30, borderRadius: theme.radius.sm, backgroundColor: theme.colors.brandTint, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon icon={Ico} size="sm" color="brand" />
                </View>
                <AppText style={{ flex: 1 }}>{label}</AppText>
              </Pressable>
            ))}
          </View>
          {kinds.statements ? (
            <View style={{ flexDirection: 'row', gap: theme.space[3], alignItems: 'flex-start', paddingTop: theme.space[2] }}>
              <Icon icon={Share2} size="sm" color="iconSecondary" />
              <View style={{ flex: 1, gap: theme.space[1] }}>
                <AppText variant="headline">{t('exp.kaspi_title')}</AppText>
                <AppText variant="callout">{t('exp.kaspi_1')}</AppText>
                <AppText variant="callout">{t('exp.kaspi_2')}</AppText>
                <AppText variant="callout">{t('exp.kaspi_3')}</AppText>
                <AppText variant="footnote">{t('exp.no_bank_link')}</AppText>
              </View>
            </View>
          ) : null}
        </Sheet>
      ) : null}
    </>
  );
}

/** One thing that needs the person: a spending to check, a pair to merge, a statement plan, a receipt on its way. */
export type AttentionItem =
  | { kind: 'check'; key: string; e: ExpenseOut }
  | { kind: 'dup'; key: string; d: ExpenseDuplicateOut }
  | { kind: 'plan'; key: string; st: StatementOut }
  | { kind: 'job'; key: string; j: ReceiptJob };

/** The queue in one order: receipts on their way first (they move), then checks, repeats, plans. */
export function attentionItems(o: { jobs: ReceiptJob[]; toCheck: ExpenseOut[]; pairs: ExpenseDuplicateOut[]; plans: StatementOut[]; statements: boolean; qr: boolean }): AttentionItem[] {
  const jobs = o.jobs.filter((j) => (j.kind === 'statement' ? o.statements : j.kind === 'qr' ? o.qr || j.state !== 'done' : true));
  return [
    ...jobs.map((j): AttentionItem => ({ kind: 'job', key: `j:${j.id}`, j })),
    ...o.toCheck.map((e): AttentionItem => ({ kind: 'check', key: `c:${e.id}`, e })),
    ...o.pairs.map((d): AttentionItem => ({ kind: 'dup', key: `d:${d.id}`, d })),
    ...(o.statements ? o.plans.map((st): AttentionItem => ({ kind: 'plan', key: `p:${st.id}`, st })) : []),
  ];
}

/**
 * «Требует внимания» (pattern 6): every «проверить», «объединить?», statement plan and receipt on its way folded
 * into one card with a count. A tap opens the queue: one thing per screen with its two answers.
 */
export function AttentionCard({ items, onOpen }: { items: AttentionItem[]; onOpen: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  if (items.length === 0) return null;
  const n = (k: AttentionItem['kind']) => items.filter((x) => x.kind === k).length;
  const reading = items.some((x) => x.kind === 'job' && (x.j.state === 'reading' || x.j.state === 'waiting'));
  const meta = [
    n('check') > 0 ? t('exp.att_check', { count: n('check') }) : null,
    n('dup') > 0 ? t('exp.att_dup', { count: n('dup') }) : null,
    n('plan') > 0 ? t('exp.att_plan', { count: n('plan') }) : null,
    reading ? t('exp.att_reading') : n('job') > 0 ? t('exp.att_job', { count: n('job') }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card testID="exp-attention" padded={false} onPress={onOpen} accessibilityLabel={`${t('exp.attention')}: ${items.length}. ${meta}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3], paddingHorizontal: theme.space[4], paddingVertical: theme.space[3], minHeight: theme.size.rowHeightMeta }}>
        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: theme.colors.highlightTint, alignItems: 'center', justifyContent: 'center' }}>
          <Icon icon={AlertCircle} size="sm" color="warning" />
        </View>
        <View style={{ flex: 1 }}>
          <AppText variant="headline">{t('exp.attention')}</AppText>
          <AppText testID="exp-attention-meta" variant="callout">
            {meta}
          </AppText>
        </View>
        <View style={{ minWidth: 28, paddingHorizontal: theme.space[2], minHeight: 24, borderRadius: 12, backgroundColor: withAlpha(theme.colors.highlight, 0.9), alignItems: 'center', justifyContent: 'center' }}>
          <AppText testID="exp-attention-count" variant="footnote" color="onHighlight" style={{ fontFamily: theme.type.sectionLabel.fontFamily }}>
            {String(items.length)}
          </AppText>
        </View>
        <Icon icon={ChevronRight} size="sm" color="iconSecondary" />
      </View>
    </Card>
  );
}

/** The queue: one item per screen, «1 из 3», «Пропустить»; an answered item leaves the list by itself. */
export function AttentionSheet({
  items,
  today,
  onClose,
  onVerify,
  onEdit,
  onType,
}: {
  items: AttentionItem[];
  today: string;
  onClose: () => void;
  onVerify: (e: ExpenseOut) => void;
  onEdit: (e: ExpenseOut) => void;
  onType: () => void;
}) {
  const { t } = useTranslation();
  const [skip, setSkip] = useState(0);
  const i = items.length === 0 ? 0 : skip % items.length;
  const item = items[i];
  let body: ReactNode = (
    <AppText testID="exp-attention-done" color="success">
      {t('exp.att_done')}
    </AppText>
  );
  if (item?.kind === 'check') body = <CheckItem e={item.e} today={today} onVerify={onVerify} onEdit={onEdit} />;
  else if (item?.kind === 'dup') body = <DuplicateItem d={item.d} today={today} />;
  else if (item?.kind === 'plan') body = <PlanItem st={item.st} onOpen={onClose} />;
  else if (item?.kind === 'job') body = <JobItem j={item.j} today={today} onType={onType} />;
  return (
    <Sheet
      testID="exp-attention-sheet"
      title={t('exp.attention')}
      onClose={onClose}
      footer={
        items.length > 1 ? (
          <Button testID="exp-attention-skip" label={t('exp.att_skip', { n: i + 1, count: items.length })} variant="text" onPress={() => setSkip((x) => x + 1)} />
        ) : null
      }
    >
      {body}
    </Sheet>
  );
}

/** «Читаю чек…», «Ждёт связи», what could not be read. */
function JobItem({ j, today, onType }: { j: ReceiptJob; today: string; onType: () => void }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const online = useConnectivity((s) => s.online);
  const what = j.kind === 'statement' ? t('exp.job_statement') : j.kind === 'qr' ? t('exp.job_qr') : t('exp.job_receipt');
  const preview = j.kind === 'qr' && j.qr ? qrPreview(j.qr) : null;
  const head = preview ? `${what}: ${formatAmount(preview.amount)}${preview.day ? ` · ${dayLabel(preview.day, today, i18n.language, t)}` : ''}` : what;
  const status =
    j.state === 'waiting'
      ? online
        ? t('exp.job_sending')
        : t(j.kind === 'statement' ? 'exp.job_waits_statement' : 'exp.job_waits')
      : j.state === 'reading'
        ? t(j.kind === 'statement' ? 'exp.statement_reading' : 'exp.job_reading')
        : (j.message ?? t('exp.receipt_failed'));
  const bad = j.state === 'failed' || j.state === 'form';
  return (
    <View testID={`exp-job-${j.id}`} style={{ gap: theme.space[3] }}>
      <View accessible accessibilityLiveRegion="polite" accessibilityLabel={`${head}. ${status}`}>
        <AppText variant="headline">{head}</AppText>
        <AppText testID={`exp-job-status-${j.id}`} variant="callout" color={bad ? 'warning' : 'ink2'}>
          {status}
        </AppText>
      </View>
      {j.state === 'form' ? <Button testID={`exp-job-type-${j.id}`} label={t('exp.job_type')} onPress={onType} /> : null}
      {bad && j.kind === 'photo' ? (
        <Button
          testID={`exp-job-retake-${j.id}`}
          label={t('exp.job_retake')}
          variant="secondary"
          onPress={() => {
            dismissJob(j.id);
            router.push({ pathname: '/receipt', params: { kind: 'camera' } });
          }}
        />
      ) : null}
      {bad ? <Button testID={`exp-job-dismiss-${j.id}`} label={t('exp.job_dismiss')} variant="text" onPress={() => dismissJob(j.id)} /> : null}
    </View>
  );
}

/** A statement plan waiting for «Да»: its numbers and one button to look and decide. */
function PlanItem({ st, onOpen }: { st: StatementOut; onOpen: () => void }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const n = planNumbers(st);
  return (
    <View testID={`exp-plan-${st.id}`} style={{ gap: theme.space[3] }}>
      <AppText variant="callout">{t('exp.plan_card')}</AppText>
      <AppText variant="headline">{planTitle(st, n.found, n.already, i18n.language, t)}</AppText>
      <Button
        testID={`exp-plan-open-${st.id}`}
        label={t('exp.plan_open')}
        onPress={() => {
          onOpen();
          router.push({ pathname: '/statement/[id]', params: { id: st.id } });
        }}
      />
    </View>
  );
}

/**
 * «Проверьте сумму» (R-36): a spending read from a receipt, a QR, a voice or a statement shows its amount big,
 * with «Верно» and «Исправить». «Верно» also confirms the day when the day was a guess.
 */
function CheckItem({ e, today, onVerify, onEdit }: { e: ExpenseOut; today: string; onVerify: (e: ExpenseOut) => void; onEdit: (e: ExpenseOut) => void }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const server = useExpenses((s) => s.categories);
  const title = lineTitle(e, server, i18n.language, t('exp.no_category'));
  const amount = formatAmount(e.amount, e.currency);
  const day = dayLabel(e.spent_on, today, i18n.language, t);
  const from = sourceWord(e.source, t);
  const dayToo = e.review_fields.includes('spent_on');
  return (
    <View testID={`exp-check-${e.id}`} style={{ gap: theme.space[3] }}>
      <View accessible accessibilityLabel={t(dayToo ? 'exp.check_a11y_day' : 'exp.check_a11y', { title, amount, day, from: from ?? '' })} style={{ gap: theme.space[1] }}>
        <AppText variant="sectionLabel" color="warning">
          {t('exp.check_title')}
        </AppText>
        <AppText variant="callout">{from ? `${title} · ${from}` : title}</AppText>
        <AmountText testID={`exp-check-amount-${e.id}`} variant="amount" maxScale={1.6} inset={theme.screenPadding * 2 + theme.space[5] * 2}>
          {amount}
        </AmountText>
        <AppText variant="callout" color={dayToo ? 'warning' : 'ink2'}>
          {dayToo ? t('exp.check_day', { day }) : day}
        </AppText>
      </View>
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[2] }}>
        <Button
          testID={`exp-check-ok-${e.id}`}
          label={t('exp.sheet_verify')}
          accessibilityLabel={t('exp.check_ok_a11y', { amount })}
          style={theme.largeFont ? undefined : { flex: 1 }}
          onPress={() => onVerify(e)}
        />
        <Button
          testID={`exp-check-edit-${e.id}`}
          label={t('exp.check_edit')}
          accessibilityLabel={t('exp.check_edit_a11y', { amount })}
          variant="secondary"
          style={theme.largeFont ? undefined : { flex: 1 }}
          onPress={() => onEdit(e)}
        />
      </View>
    </View>
  );
}

/** «Похоже, эта трата уже есть»: the two in words, [Объединить] [Это разные]. */
function DuplicateItem({ d, today }: { d: ExpenseDuplicateOut; today: string }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const server = useExpenses((s) => s.categories);
  const say = (r: PlanResult) => {
    if (r === 'offline') useToast.getState().show(t('exp.dup_offline'), 4000);
    else if (r === 'expired') useToast.getState().show(t('exp.dup_gone'), 4000);
    else if (r === 'failed') useToast.getState().show(t('exp.plan_failed'), 4000);
  };
  const line = (e: ExpenseOut, testID: string) => {
    const from = sourceWord(e.source, t) ?? t('exp.src_hand');
    const text = `${lineTitle(e, server, i18n.language, t('exp.no_category'))} · ${formatAmount(e.amount, e.currency)} · ${dayLabel(e.spent_on, today, i18n.language, t)} · ${from}`;
    return (
      <AppText testID={testID} key={testID}>
        {text}
      </AppText>
    );
  };
  return (
    <View testID={`exp-dup-${d.id}`} style={{ gap: theme.space[3] }}>
      <AppText variant="headline">{t('exp.dup_title')}</AppText>
      <View accessible style={{ gap: theme.space[1], backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.md, padding: theme.space[3] }}>
        {line(d.keep, `exp-dup-keep-${d.id}`)}
        {line(d.other, `exp-dup-other-${d.id}`)}
      </View>
      <AppText variant="callout">{t('exp.dup_what')}</AppText>
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[2] }}>
        <Button testID={`exp-dup-merge-${d.id}`} label={t('exp.dup_merge')} style={theme.largeFont ? undefined : { flex: 1 }} onPress={async () => say(await mergeDuplicate(d))} />
        <Button
          testID={`exp-dup-no-${d.id}`}
          label={t('exp.dup_different')}
          variant="secondary"
          style={theme.largeFont ? undefined : { flex: 1 }}
          onPress={async () => say(await dismissDuplicate(d))}
        />
      </View>
    </View>
  );
}
