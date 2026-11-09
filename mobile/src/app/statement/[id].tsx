import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { StatementRowOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { StandaloneUndoStrip } from '@/components/UndoStrip';
import { formatMinor, toMinor } from '@/expenses/calc';
import { dayName, planTitle } from '@/expenses/feed';
import { confirmStatement, loadStatement, planNumbers, rejectStatement, undoStatement, type PlanResult } from '@/expenses/receipts';
import { useExpenses } from '@/expenses/store';
import { useConnectivity } from '@/store/connectivity';
import { useTheme } from '@/theme';

const BANKS: Record<string, string> = { kaspi_gold: 'Kaspi Gold', halyk: 'Halyk', freedom: 'Freedom' };

/**
 * The statement plan (3-engineering 4.11, 6.13; 2-design S40 path 3; US-32): «Нашёл 86 операций за
 * октябрь, 4 уже есть». Nothing is written before the one «Да»; after it, the one «Отменить» takes
 * the whole batch back. The numbers are code's (`adds`, `calc.py`); when the rows are here the phone
 * counts them again with `calc.ts` and says so if the two differ. Needs the internet to decide.
 * `id` is the job (just brought) or the statement (from «Расходы»).
 */
export default function StatementScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { id } = useLocalSearchParams<{ id: string }>();
  const job = useExpenses((s) => s.jobs[id]);
  const statementId = job ? job.statementId : id;
  const st = useExpenses((s) => (statementId ? s.statements[statementId] : undefined));
  const online = useConnectivity((s) => s.online);
  const [rows, setRows] = useState<StatementRowOut[] | null>(null);
  const [showRows, setShowRows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!statementId || st?.status !== 'proposed' || rows) return;
    let gone = false;
    void loadStatement(statementId).then((r) => {
      if (!gone && r.rows) setRows(r.rows);
    });
    return () => {
      gone = true;
    };
  }, [statementId, st?.status, rows]);

  const n = useMemo(() => (st ? planNumbers(st, rows) : null), [st, rows]);
  const done = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const tell = (r: PlanResult) => {
    if (r === 'offline') setNote(t('exp.plan_offline'));
    else if (r === 'expired') setNote(t('exp.plan_expired'));
    else if (r === 'failed') setNote(t('exp.plan_failed'));
    else setNote(null);
  };

  const body = () => {
    if (!st) {
      if (job?.state === 'failed') {
        return (
          <>
            <AppText variant="title1" accessibilityRole="header">
              {t('exp.statement_failed_title')}
            </AppText>
            <AppText testID="plan-failed">{job.message ?? t('exp.statement_failed')}</AppText>
            <Button testID="plan-done" label={t('common.ok')} onPress={done} />
          </>
        );
      }
      return (
        <>
          <AppText testID="plan-reading" variant="title1" accessibilityRole="header" accessibilityLiveRegion="polite">
            {online ? t('exp.statement_reading') : t('exp.statement_waits')}
          </AppText>
          <AppText>{t('exp.statement_nothing_yet')}</AppText>
          <Button testID="plan-done" label={t('common.ok')} variant="outline" onPress={done} />
        </>
      );
    }
    if (st.status === 'confirmed') {
      return (
        <>
          <AppText testID="plan-confirmed" variant="title1" accessibilityRole="header" accessibilityLiveRegion="polite">
            {t('exp.statement_added', { count: n?.add ?? 0 })}
          </AppText>
          {st.rows_similar > 0 ? <AppText>{t('exp.plan_similar_after', { count: st.rows_similar })}</AppText> : null}
          {st.action_id ? <Button testID="plan-undo" label={t('common.undo')} variant="outline" onPress={() => void undoStatement(st.id)} /> : null}
          <Button testID="plan-done" label={t('exp.plan_done')} onPress={done} />
        </>
      );
    }
    if (st.status !== 'proposed') {
      const key = st.status === 'undone' ? 'exp.plan_undone' : st.status === 'rejected' ? 'exp.plan_rejected' : 'exp.plan_expired';
      return (
        <>
          <AppText testID={`plan-${st.status}`} variant="title1" accessibilityRole="header" accessibilityLiveRegion="polite">
            {t(key)}
          </AppText>
          <Button testID="plan-done" label={t('exp.plan_done')} onPress={done} />
        </>
      );
    }
    const title = planTitle(st, n!.found, n!.already, lang, t);
    const cur = st.currency;
    const a = n!.adds;
    return (
      <>
        <AppText testID="plan-title" variant="title1" accessibilityRole="header">
          {title}
        </AppText>
        {st.bank && BANKS[st.bank] ? <AppText variant="meta">{BANKS[st.bank]}</AppText> : null}
        {a ? (
          <View testID="plan-numbers" style={{ gap: theme.space[2], borderWidth: 2, borderColor: theme.colors.lineStrong, borderRadius: theme.radius.card, padding: theme.space[4], backgroundColor: theme.colors.surface }}>
            <AppText variant="meta">{t('exp.plan_spent')}</AppText>
            <AppText testID="plan-spent" variant="amount" maxFontSizeMultiplier={1.6}>
              {formatMinor(n!.spent ?? 0n, cur)}
            </AppText>
            {a.refund > 0n ? <AppText testID="plan-refund">{t('exp.plan_refund', { amount: formatMinor(a.refund, cur) })}</AppText> : null}
            {a.income > 0n ? <AppText testID="plan-income">{t('exp.plan_income', { amount: formatMinor(a.income, cur) })}</AppText> : null}
            {a.transfers > 0n ? <AppText testID="plan-transfers">{t('exp.plan_transfers', { amount: formatMinor(a.transfers, cur) })}</AppText> : null}
            {a.transfer_own > 0n ? <AppText testID="plan-own">{t('exp.plan_own', { amount: formatMinor(a.transfer_own, cur) })}</AppText> : null}
          </View>
        ) : null}
        {st.check?.ok ? (
          <AppText testID="plan-check-ok" variant="bodyStrong">
            {t('exp.plan_check_ok')}
          </AppText>
        ) : st.check ? (
          <View testID="plan-check-bad" style={{ gap: theme.space[1] }}>
            <AppText color="warnText" variant="bodyStrong">
              {t('exp.plan_check_bad')}
            </AppText>
            {st.check.lines
              .filter((l) => !l.ok)
              .map((l) => (
                <AppText key={l.key} color="warnText">
                  {t('exp.plan_check_line', { title: l.title, bank: l.bank ?? '—', ours: l.ours ?? '—' })}
                </AppText>
              ))}
          </View>
        ) : (
          <AppText testID="plan-check-none">{t('exp.plan_check_none')}</AppText>
        )}
        {n!.matches === false ? (
          <AppText testID="plan-mismatch" color="warnText">
            {t('exp.plan_mismatch')}
          </AppText>
        ) : null}
        {st.rows_similar > 0 ? <AppText testID="plan-similar">{t('exp.plan_similar', { count: st.rows_similar })}</AppText> : null}
        <AppText variant="meta">{t('exp.plan_one_undo')}</AppText>
        {note ? (
          <AppText testID="plan-note" color="warnText" accessibilityLiveRegion="polite">
            {note}
          </AppText>
        ) : null}
        <Button
          testID="plan-yes"
          label={t('exp.plan_yes', { count: n!.add })}
          disabled={busy || n!.add === 0}
          onPress={async () => {
            setBusy(true);
            tell(await confirmStatement(st.id));
            setBusy(false);
          }}
        />
        <Button
          testID="plan-no"
          label={t('common.not_now')}
          variant="outline"
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            const r = await rejectStatement(st.id);
            setBusy(false);
            tell(r);
          }}
        />
        {rows && rows.length > 0 ? (
          <Button
            testID="plan-rows"
            label={showRows ? t('exp.plan_hide_rows') : t('exp.plan_show_rows', { count: rows.length })}
            variant="text"
            onPress={() => setShowRows((v) => !v)}
          />
        ) : null}
        {showRows && rows ? (
          <View testID="plan-row-list" style={{ gap: theme.space[2] }}>
            {rows.map((r) => (
              <PlanRow key={`${r.n}:${r.date}`} r={r} lang={lang} />
            ))}
          </View>
        ) : null}
      </>
    );
  };

  return (
    <>
      <Screen testID="plan-screen">
        <View style={{ gap: theme.space[4] }}>{body()}</View>
      </Screen>
      <StandaloneUndoStrip />
    </>
  );
}

function PlanRow({ r, lang }: { r: StatementRowOut; lang: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const incoming = r.direction === 'refund' || r.direction === 'income';
  const amount = `${incoming ? '+' : ''}${formatMinor(toMinor(r.amount) ?? 0n, r.currency)}`;
  const tag =
    r.state === 'existing'
      ? t('exp.row_exists')
      : r.state === 'similar'
        ? t('exp.row_similar')
        : r.direction === 'transfer_own'
          ? t('exp.row_own')
          : r.category_key === 'transfers'
            ? t('exp.row_transfer')
            : r.direction === 'income'
              ? t('exp.row_income')
              : null;
  const what = r.description ?? r.note ?? '';
  return (
    <View
      testID={`plan-row-${r.n}`}
      accessible
      accessibilityLabel={[dayName(r.date, lang), what, amount, tag].filter(Boolean).join('. ')}
      style={{ flexDirection: 'row', gap: theme.space[2], minHeight: theme.size.minTouch, alignItems: 'center', borderBottomWidth: 1, borderColor: theme.colors.line, opacity: r.state === 'existing' ? 0.6 : 1 }}
    >
      <View style={{ flex: 1 }}>
        <AppText>{what}</AppText>
        <AppText variant="meta">{tag ? `${dayName(r.date, lang)} · ${tag}` : dayName(r.date, lang)}</AppText>
      </View>
      <AppText variant="number">{amount}</AppText>
    </View>
  );
}
