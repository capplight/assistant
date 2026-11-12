import { router } from 'expo-router';
import { Camera, FileText, Image as ImageIcon, QrCode, Share2 } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import type { ExpenseDuplicateOut, ExpenseOut, StatementOut } from '@/api/types';
import { formatAmount } from '@/expenses/calc';
import { dayLabel, lineTitle, planTitle } from '@/expenses/feed';
import { dismissDuplicate, dismissJob, mergeDuplicate, planNumbers, qrPreview, type PlanResult } from '@/expenses/receipts';
import { useExpenses, type ReceiptJob } from '@/expenses/store';
import { useConnectivity } from '@/store/connectivity';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

import { AmountText } from '../AmountText';
import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import { Sheet } from './ExpenseParts';

/** Shown on the card at most; the rest behind «Показать все». */
export const CHECK_CARDS = 3;

const card = (theme: ReturnType<typeof useTheme>, strong = false) => ({
  backgroundColor: theme.colors.surface,
  borderWidth: strong ? 2 : 1,
  borderColor: strong ? theme.colors.iconSecondary : theme.colors.separator,
  borderRadius: theme.radius.lg,
  padding: theme.space[4],
  gap: theme.space[3],
});

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

/**
 * «Чек или выписка»: one big button, then a sheet of four plain rows (56 pt) and how to bring a
 * statement from Kaspi. Each opens the receipt screen, which explains the camera before asking.
 */
export function BringButton({ pageId }: { pageId: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const go = (kind: string) => {
    setOpen(false);
    router.push({ pathname: '/receipt', params: { kind, page: pageId } });
  };
  const rows = [
    { kind: 'camera', label: t('exp.bring_camera'), Icon: Camera },
    { kind: 'photo', label: t('exp.bring_photo'), Icon: ImageIcon },
    { kind: 'qr', label: t('exp.bring_qr'), Icon: QrCode },
    { kind: 'statement', label: t('exp.bring_statement'), Icon: FileText },
  ];
  return (
    <>
      <Button testID="exp-bring" label={t('exp.bring')} variant="secondary" icon={<Camera size={24} color={theme.colors.brand} />} onPress={() => setOpen(true)} />
      {open ? (
        <Sheet testID="exp-bring-sheet" title={t('exp.bring_title')} onClose={() => setOpen(false)}>
          {rows.map(({ kind, label, Icon }) => (
            <Pressable
              key={kind}
              testID={`exp-bring-${kind}`}
              accessibilityRole="button"
              accessibilityLabel={label}
              onPress={() => go(kind)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3], minHeight: theme.size.buttonHeight }}
            >
              <Icon size={theme.size.icon} color={theme.colors.ink} strokeWidth={2} />
              <AppText style={{ flex: 1 }}>{label}</AppText>
            </Pressable>
          ))}
          <View style={{ flexDirection: 'row', gap: theme.space[3], alignItems: 'flex-start', paddingTop: theme.space[2] }}>
            <Share2 size={theme.size.icon} color={theme.colors.ink2} strokeWidth={2} />
            <View style={{ flex: 1, gap: theme.space[1] }}>
              <AppText variant="bodyStrong">{t('exp.kaspi_title')}</AppText>
              <AppText>{t('exp.kaspi_1')}</AppText>
              <AppText>{t('exp.kaspi_2')}</AppText>
              <AppText>{t('exp.kaspi_3')}</AppText>
              <AppText variant="callout">{t('exp.no_bank_link')}</AppText>
            </View>
          </View>
        </Sheet>
      ) : null}
    </>
  );
}

/** «Читаю чек…», «Ждёт связи», what could not be read: one line per receipt / statement on its way. */
export function JobLines({ jobs, today, onType }: { jobs: ReceiptJob[]; today: string; onType: () => void }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const online = useConnectivity((s) => s.online);
  if (jobs.length === 0) return null;
  return (
    <View testID="exp-jobs" style={{ gap: theme.space[2] }}>
      {jobs.map((j) => {
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
          <View key={j.id} testID={`exp-job-${j.id}`} style={[card(theme), { gap: theme.space[2] }]}>
            <View accessible accessibilityLiveRegion="polite" accessibilityLabel={`${head}. ${status}`}>
              <AppText variant="bodyStrong">{head}</AppText>
              <AppText testID={`exp-job-status-${j.id}`} color={bad ? 'warning' : 'ink2'}>
                {status}
              </AppText>
            </View>
            {j.state === 'form' ? <Button testID={`exp-job-type-${j.id}`} label={t('exp.job_type')} minHeight={theme.size.minTouch} onPress={onType} /> : null}
            {bad && j.kind === 'photo' ? (
              <Button
                testID={`exp-job-retake-${j.id}`}
                label={t('exp.job_retake')}
                variant="secondary"
                minHeight={theme.size.minTouch}
                onPress={() => {
                  dismissJob(j.id);
                  router.push({ pathname: '/receipt', params: { kind: 'camera' } });
                }}
              />
            ) : null}
            {bad ? <Button testID={`exp-job-dismiss-${j.id}`} label={t('exp.job_dismiss')} variant="text" minHeight={theme.size.minTouch} onPress={() => dismissJob(j.id)} /> : null}
          </View>
        );
      })}
    </View>
  );
}

/** A statement plan waiting for «Да»: its numbers and one button to look and decide. */
export function PlanCards({ plans }: { plans: StatementOut[] }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  if (plans.length === 0) return null;
  return (
    <View style={{ gap: theme.space[2] }}>
      {plans.map((st) => {
        const n = planNumbers(st);
        const title = planTitle(st, n.found, n.already, i18n.language, t);
        return (
          <View key={st.id} testID={`exp-plan-${st.id}`} style={card(theme, true)}>
            <AppText variant="callout">{t('exp.plan_card')}</AppText>
            <AppText variant="bodyStrong">{title}</AppText>
            <Button testID={`exp-plan-open-${st.id}`} label={t('exp.plan_open')} onPress={() => router.push({ pathname: '/statement/[id]', params: { id: st.id } })} />
          </View>
        );
      })}
    </View>
  );
}

/**
 * «Проверьте сумму» (R-36): a spending read from a receipt, a QR, a voice or a statement shows its
 * amount big, with «Верно» and «Изменить» right there. «Верно» also confirms the day when the day was
 * a guess; «Изменить» opens the keys of that spending.
 */
export function CheckCards({
  entries,
  today,
  onVerify,
  onEdit,
  onShowAll,
}: {
  entries: ExpenseOut[];
  today: string;
  onVerify: (e: ExpenseOut) => void;
  onEdit: (e: ExpenseOut) => void;
  onShowAll: () => void;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const server = useExpenses((s) => s.categories);
  if (entries.length === 0) return null;
  const shown = entries.slice(0, CHECK_CARDS);
  return (
    <View testID="exp-check" style={{ gap: theme.space[2] }}>
      <AppText variant="sectionLabel" accessibilityRole="header" color="warning">
        {t('exp.check_title')}
      </AppText>
      {shown.map((e) => {
        const title = lineTitle(e, server, i18n.language, t('exp.no_category'));
        const amount = formatAmount(e.amount, e.currency);
        const day = dayLabel(e.spent_on, today, i18n.language, t);
        const from = sourceWord(e.source, t);
        const dayToo = e.review_fields.includes('spent_on');
        return (
          <View key={e.id} testID={`exp-check-${e.id}`} style={[card(theme, true), { borderColor: theme.colors.highlight }]}>
            <View accessible accessibilityLabel={t(dayToo ? 'exp.check_a11y_day' : 'exp.check_a11y', { title, amount, day, from: from ?? '' })}>
              <AppText variant="callout">{from ? `${title} · ${from}` : title}</AppText>
              <AmountText testID={`exp-check-amount-${e.id}`} variant="largeTitle" maxScale={1.6} inset={theme.screenPadding * 2 + 40}>
                {amount}
              </AmountText>
              <AppText color={dayToo ? 'warning' : 'ink2'}>{dayToo ? t('exp.check_day', { day }) : day}</AppText>
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
      })}
      {entries.length > shown.length ? (
        <Button testID="exp-check-all" label={t('exp.check_all', { count: entries.length })} variant="text" minHeight={theme.size.minTouch} onPress={onShowAll} />
      ) : null}
    </View>
  );
}

/** «Похоже, эта трата уже есть»: the two side by side in words, [Объединить] [Это разные]. */
export function DuplicateCards({ pairs, today }: { pairs: ExpenseDuplicateOut[]; today: string }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const server = useExpenses((s) => s.categories);
  if (pairs.length === 0) return null;
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
    <View testID="exp-dups" style={{ gap: theme.space[2] }}>
      {pairs.map((d) => (
        <View key={d.id} testID={`exp-dup-${d.id}`} style={card(theme, true)}>
          <AppText variant="bodyStrong">{t('exp.dup_title')}</AppText>
          <View accessible style={{ gap: theme.space[1] }}>
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
      ))}
    </View>
  );
}
