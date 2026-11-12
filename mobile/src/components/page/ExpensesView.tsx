import { router } from 'expo-router';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ExpenseOut } from '@/api/types';
import { formatMinor, inPeriod, minorToDecimal, periodOf, shiftPeriod, toMinor, type Period } from '@/expenses/calc';
import { categoryByKey, categoryTitle, chipCategories, orderedCategories, type Category } from '@/expenses/categories';
import { storedExpression } from '@/expenses/expression';
import { bars, board, dayLabel, feed, lineTitle, liveEntries, periodTitle, spokenAmount, type FeedDay } from '@/expenses/feed';
import { proposedStatements, refreshDuplicates, refreshStatements, visibleDuplicates, visibleJobs } from '@/expenses/receipts';
import { addExpense, changeExpense, deleteExpense, reorderCategories } from '@/expenses/service';
import { useExpenses } from '@/expenses/store';
import { kickSync, syncBlocked } from '@/services';
import { localDate } from '@/tasks/rows';
import { useTheme } from '@/theme';

import { AmountText } from '../AmountText';
import { AppText } from '../AppText';
import { Button } from '../Button';
import { RecordRow } from '../RecordRow';
import { useMinuteClock } from '../ReminderLists';
import { BringButton, CheckCards, DuplicateCards, JobLines, PlanCards, sourceWord } from './ExpenseInbox';
import { CategoryChips, DayChip, EntryPanel, Sheet, SumDisplay, useSum } from './ExpenseParts';
import { ExpenseKeypad } from './ExpenseKeypad';
import type { ViewProps } from './registry';

/** The keys fold to one button when there are more spendings than this (template-screens 2.2). */
export const FOLD_AFTER = 10;
/** How often «Читаю чек…» wakes the outbox while the page is open. */
const READ_POLL_MS = 3000;
/** The new line is marked this long. */
const MARK_MS = 600;

type Kind = 'week' | 'month' | 'year';

type Item = { type: 'day'; day: FeedDay } | { type: 'row'; e: ExpenseOut; last: boolean; day: FeedDay };

/**
 * «Расходы» — the expense calculator (template-screens 2.2; replaces S40 and keeps its rules): the
 * board with the period's total (counted by code in tiyn, the same rules as the server's
 * `calc.py`), the 64 pt keys where «1200+350» is added by code, the 8 chips in the person's order,
 * the bars by category and the feed like a receipt, by day with «Итого за день». Everything here
 * works offline and in «Без ИИ»; only a free phrase in the line waits for the server.
 * ≥150%: the keys open on the whole screen, the chips are one column, the board's number grows to 1.6×.
 */
export function ExpensesView({ page, entries, frameTop, ordering }: ViewProps) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const today = localDate(useMinuteClock());
  const stored = useExpenses((s) => s.entries);
  const edits = useExpenses((s) => s.edits);
  const server = useExpenses((s) => s.categories);
  const orderEdit = useExpenses((s) => s.orderEdit);
  const [kind, setKind] = useState<Kind>('month');
  const [period, setPeriod] = useState<Period>(() => periodOf('month', today));
  const [onlyToCheck, setOnlyToCheck] = useState(false);
  const [entryOpen, setEntryOpen] = useState<boolean | null>(null);
  const [fullEntry, setFullEntry] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [marked, setMarked] = useState<string | null>(null);
  const [kaspi, setKaspi] = useState(false);
  const [editFirst, setEditFirst] = useState(false);
  const jobs = useExpenses((s) => s.jobs);
  const statements = useExpenses((s) => s.statements);
  const duplicates = useExpenses((s) => s.duplicates);
  const decided = useExpenses((s) => s.decided);

  // Week 13: «Объединить?» pairs and plans the server has now (online; offline the phone's copies stay).
  useEffect(() => {
    void refreshDuplicates();
    void refreshStatements();
  }, [page.id]);

  // An expense shows only while its record is live: a record trashed on the page hides it.
  const deadItems = useMemo(
    () => new Set((entries ?? []).filter((x) => x.record.deletedAt !== null && x.record.serverId).map((x) => x.record.serverId!)),
    [entries],
  );
  const live = useMemo(() => liveEntries(stored, edits, deadItems), [stored, edits, deadItems]);
  const chips = useMemo(
    () => orderedCategories(chipCategories(server), live, today, orderEdit?.keys ?? null),
    // The chips do not move under a finger: the order by use is taken when the page opens or the person changes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [server, orderEdit, today, page.id],
  );
  const b = useMemo(() => board(live, period, server), [live, period, server]);
  const days = useMemo(() => feed(live, period, { onlyToCheck, server }), [live, period, onlyToCheck, server]);
  const catBars = useMemo(() => bars(b, server, lang, t('exp.no_category')), [b, server, lang, t]);
  const items = useMemo(() => {
    const out: Item[] = [];
    for (const day of days) {
      out.push({ type: 'day', day });
      day.entries.forEach((e, i) => out.push({ type: 'row', e, day, last: i === day.entries.length - 1 }));
    }
    return out;
  }, [days]);

  useEffect(() => {
    if (!marked) return;
    const timer = setTimeout(() => setMarked(null), MARK_MS);
    return () => clearTimeout(timer);
  }, [marked]);

  const shownJobs = useMemo(() => visibleJobs(jobs), [jobs]);
  const plans = useMemo(() => proposedStatements(statements), [statements]);
  const pairs = useMemo(() => visibleDuplicates(duplicates, decided, live), [duplicates, decided, live]);
  const toCheck = useMemo(
    () => live.filter((e) => e.review_fields.includes('amount') && !e.id.startsWith('local:')).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    [live],
  );
  const openEntry = () => (theme.largeFont ? setFullEntry(true) : setEntryOpen(true));
  const reading = shownJobs.some((j) => j.state === 'reading');

  // «Читаю чек…»: while the page is open the server is asked again soon (the outbox keeps its own
  // backoff; this only wakes it instead of waiting for the 30 s foreground sync).
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => {
      if (!syncBlocked()) kickSync();
    }, READ_POLL_MS);
    return () => clearInterval(timer);
  }, [reading]);

  const empty = live.length === 0;
  // Open on the first visit and on an empty page; folded when there are more than 10 spendings.
  const open = !theme.largeFont && (entryOpen ?? (empty || live.length <= FOLD_AFTER));

  const pick = (k: Kind) => {
    setKind(k);
    setPeriod(periodOf(k, today));
  };

  const save = async (x: { minor: bigint; expression: string | null; category: Category | null; day: string }) => {
    const amount = formatMinor(x.minor);
    const stripText = x.category ? t('exp.saved', { amount, category: categoryTitle(x.category, lang) }) : t('exp.saved_plain', { amount });
    const key = await addExpense({ minor: x.minor, expression: x.expression, category: x.category, spentOn: x.day }, stripText);
    setMarked(key);
    // The new line must be seen: the period jumps to the day it was written for.
    if (!inPeriod(x.day, period)) setPeriod(periodOf(kind, x.day));
  };

  const header = (
    <View style={{ gap: theme.space[4], marginBottom: theme.space[3] }}>
      {frameTop}
      <PeriodSegments value={kind} onChange={pick} />
      <BoardCard
        title={periodTitle(period, lang)}
        board={b}
        onShift={(step) => setPeriod((p) => shiftPeriod(p, step))}
        canNext={(period.to ?? today) < today}
        onlyToCheck={onlyToCheck}
        onToCheck={() => setOnlyToCheck((v) => !v)}
      />
      <PlanCards plans={plans} />
      <JobLines jobs={shownJobs} today={today} onType={openEntry} />
      <DuplicateCards pairs={pairs} today={today} />
      <CheckCards
        entries={toCheck}
        today={today}
        onVerify={(e) =>
          void changeExpense(
            e.id,
            { review_fields: e.review_fields.filter((f) => f !== 'amount' && f !== 'spent_on') },
            t('exp.verified', { amount: formatMinor(toMinor(e.amount) ?? 0n, e.currency) }),
          )
        }
        onEdit={(e) => {
          setEditFirst(true);
          setMenu(e.id);
        }}
        onShowAll={() => setOnlyToCheck(true)}
      />
      {ordering ? <CategoryOrder chips={chips} pending={orderEdit?.keys ?? null} /> : null}
      {open ? (
        <InlineEntry today={today} chips={chips} onSave={save} onFold={live.length > 0 ? () => setEntryOpen(false) : null} />
      ) : (
        <Button
          testID="exp-enter"
          label={t('exp.enter')}
          minHeight={theme.size.primaryTouch}
          onPress={() => (theme.largeFont ? setFullEntry(true) : setEntryOpen(true))}
        />
      )}
      {open ? (
        <AppText variant="meta" testID="exp-or-say">
          {empty ? t('exp.empty_hint') : t('exp.or_say')}
        </AppText>
      ) : null}
      <BringButton pageId={page.id} />
      {empty ? <Button testID="exp-kaspi" label={t('exp.kaspi_link')} variant="text" minHeight={theme.size.minTouch} onPress={() => setKaspi(true)} style={styles.start} /> : null}
      {catBars.length > 0 ? (
        <View testID="exp-bars" style={{ gap: theme.space[3] }}>
          <AppText variant="section" accessibilityRole="header">
            {t('exp.by_category')}
          </AppText>
          {catBars.map((bar) => (
            <View
              key={bar.key || 'none'}
              testID={`exp-bar-${bar.key || 'none'}`}
              accessible
              accessibilityLabel={t('exp.by_category_a11y', { title: bar.title, amount: formatMinor(bar.minor), share: Math.round(bar.share) })}
              style={{ gap: theme.space[1] }}
            >
              <View style={[styles.row, { gap: theme.space[2] }]}>
                <AppText style={styles.flex}>{bar.title}</AppText>
                <AppText testID={`exp-bar-amount-${bar.key || 'none'}`} variant="number">
                  {formatMinor(bar.minor)}
                </AppText>
              </View>
              <View style={{ height: 10, borderRadius: 5, backgroundColor: theme.colors.line, overflow: 'hidden' }}>
                <View style={{ width: `${Math.max(2, bar.share)}%`, height: 10, backgroundColor: theme.colors.accent }} />
              </View>
            </View>
          ))}
        </View>
      ) : null}
      <AppText variant="section" accessibilityRole="header">
        {t('exp.feed')}
      </AppText>
      {days.length === 0 && !empty ? <AppText testID="exp-feed-none">{t('exp.feed_none')}</AppText> : null}
    </View>
  );

  const renderItem = ({ item }: { item: Item }) => {
    if (item.type === 'day') {
      return (
        <View testID={`exp-day-${item.day.date}`} style={[styles.row, { alignItems: 'center', gap: theme.space[2], paddingTop: theme.space[4], paddingBottom: theme.space[2] }]}>
          <View style={[styles.flex, styles.dash, { borderColor: theme.colors.lineStrong }]} />
          <AppText variant="bodyStrong" accessibilityRole="header">
            {dayLabel(item.day.date, today, lang, t)}
          </AppText>
          <View style={[styles.flex, styles.dash, { borderColor: theme.colors.lineStrong }]} />
        </View>
      );
    }
    return (
      <View>
        <FeedLine e={item.e} today={today} marked={marked === item.e.id || marked === `local:${item.e.client_id}`} onMenu={() => setMenu(item.e.id)} />
        {item.last ? (
          <View style={[styles.row, styles.dashTop, { borderColor: theme.colors.lineStrong, paddingVertical: theme.space[2] }]}>
            <AppText testID={`exp-day-total-${item.day.date}`} variant="number" style={[styles.flex, styles.right]}>
              {t('exp.day_total', { amount: formatMinor(item.day.total) })}
            </AppText>
          </View>
        ) : null}
      </View>
    );
  };

  // Records on the page that are not a spending (moved here, a voice not read yet, a phrase saved as a note): still shown.
  const expenseItems = new Set(Object.values(stored).map((e) => e.item_id).filter((x): x is string => !!x));
  const others = (entries ?? []).filter((x) => x.record.deletedAt === null && !(x.record.serverId && expenseItems.has(x.record.serverId)));
  const footer =
    others.length > 0 ? (
      <View testID="exp-others" style={{ gap: theme.space[2], paddingTop: theme.space[6] }}>
        <AppText variant="section" accessibilityRole="header">
          {t('exp.other_records')}
        </AppText>
        {others.map((x) => (
          <RecordRow
            key={x.record.id}
            record={x.record}
            onPress={() => router.navigate({ pathname: '/record/[id]', params: { id: x.record.id, from: page.id } })}
          />
        ))}
      </View>
    ) : null;

  const menuEntry = menu ? live.find((e) => e.id === menu) : undefined;
  const recordOf = (e: ExpenseOut) => (entries ?? []).find((x) => x.record.serverId && x.record.serverId === e.item_id)?.record ?? null;

  return (
    <>
      <FlatList
        testID="exp-list"
        data={items}
        keyExtractor={(it) => (it.type === 'day' ? `d:${it.day.date}` : `e:${it.e.id}`)}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListFooterComponent={footer ?? undefined}
        contentContainerStyle={{ paddingHorizontal: theme.screenPadding, paddingTop: theme.space[4], paddingBottom: theme.space[8] }}
        keyboardShouldPersistTaps="handled"
      />
      {fullEntry ? (
        <FullEntry
          today={today}
          chips={chips}
          onClose={() => setFullEntry(false)}
          onSave={async (x) => {
            setFullEntry(false);
            await save(x);
          }}
        />
      ) : null}
      {menuEntry ? (
        <ExpenseSheet
          e={menuEntry}
          today={today}
          chips={chips}
          hasRecord={!!recordOf(menuEntry)}
          startEditing={editFirst}
          onOpenRecord={() => {
            const rec = recordOf(menuEntry);
            setMenu(null);
            if (rec) router.navigate({ pathname: '/record/[id]', params: { id: rec.id, from: page.id } });
          }}
          onClose={() => {
            setMenu(null);
            setEditFirst(false);
          }}
        />
      ) : null}
      {kaspi ? (
        <Sheet testID="exp-kaspi-sheet" title={t('exp.kaspi_title')} onClose={() => setKaspi(false)}>
          <AppText>{t('exp.kaspi_1')}</AppText>
          <AppText>{t('exp.kaspi_2')}</AppText>
          <AppText>{t('exp.kaspi_3')}</AppText>
        </Sheet>
      ) : null}
    </>
  );
}

function PeriodSegments({ value, onChange }: { value: Kind; onChange: (k: Kind) => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const items: { key: Kind; label: string }[] = [
    { key: 'week', label: t('exp.period_week') },
    { key: 'month', label: t('exp.period_month') },
    { key: 'year', label: t('exp.period_year') },
  ];
  return (
    <View accessibilityRole="tablist" accessibilityLabel={t('exp.periods_a11y')} style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[2] }}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            testID={`exp-period-${it.key}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(it.key)}
            style={{
              flex: theme.largeFont ? undefined : 1,
              minHeight: theme.size.minTouch,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: theme.radius.button,
              borderWidth: on ? 3 : 1,
              borderColor: on ? theme.colors.accent : theme.colors.lineStrong,
              backgroundColor: on ? theme.colors.surface : 'transparent',
            }}
          >
            <AppText variant={on ? 'bodyStrong' : 'body'}>{it.label}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The «табло»: ‹ period ›, the total, «23 траты · ⚠ проверить: 2», other currencies apart. */
function BoardCard({
  title,
  board: b,
  onShift,
  canNext,
  onlyToCheck,
  onToCheck,
}: {
  title: string;
  board: ReturnType<typeof board>;
  onShift: (step: -1 | 1) => void;
  canNext: boolean;
  onlyToCheck: boolean;
  onToCheck: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const main = b.main;
  const spent = main?.total ?? 0n;
  const currency = main?.currency ?? 'KZT';
  const amount = formatMinor(spent, currency);
  const arrow = (step: -1 | 1) => (
    <Pressable
      testID={step < 0 ? 'exp-prev' : 'exp-next'}
      accessibilityRole="button"
      accessibilityLabel={t(step < 0 ? 'exp.prev_a11y' : 'exp.next_a11y')}
      accessibilityState={{ disabled: step > 0 && !canNext }}
      disabled={step > 0 && !canNext}
      onPress={() => onShift(step)}
      style={{ width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center', opacity: step > 0 && !canNext ? 0.35 : 1 }}
    >
      {step < 0 ? <ChevronLeft size={28} color={theme.colors.ink} /> : <ChevronRight size={28} color={theme.colors.ink} />}
    </Pressable>
  );
  return (
    <View
      testID="exp-board"
      style={{ backgroundColor: theme.colors.surface, borderWidth: 2, borderColor: theme.colors.lineStrong, borderRadius: theme.radius.card, padding: theme.space[4], gap: theme.space[2] }}
    >
      <View style={[styles.row, { alignItems: 'center' }]}>
        {arrow(-1)}
        <AppText testID="exp-period-title" variant="title2" accessibilityRole="header" style={[styles.flex, styles.center]}>
          {title}
        </AppText>
        {arrow(1)}
      </View>
      <AppText variant="meta" style={styles.right}>
        {t('exp.total')}
      </AppText>
      <AmountText
        testID="exp-total"
        variant="amount"
        maxScale={1.6}
        inset={theme.screenPadding * 2 + theme.space[4] * 2 + 4}
        accessibilityLabel={t('exp.total_a11y', { period: title, amount: spokenAmount(minorToDecimal(spent), currency) })}
        accessibilityLiveRegion="polite"
        style={styles.right}
      >
        {amount}
      </AmountText>
      {!main || main.count === 0 ? (
        <AppText testID="exp-empty-total" variant="meta" style={styles.right}>
          {t('exp.empty_total')}
        </AppText>
      ) : (
        <View style={[styles.row, { justifyContent: 'flex-end', flexWrap: 'wrap', gap: theme.space[2], alignItems: 'center' }]}>
          <AppText testID="exp-count" variant="meta">
            {t('exp.count', { count: main.count })}
          </AppText>
          {b.review > 0 || onlyToCheck ? (
            <Pressable
              testID="exp-to-check"
              accessibilityRole="button"
              accessibilityLabel={onlyToCheck ? t('exp.to_check_all') : t('exp.to_check_a11y', { n: b.review })}
              accessibilityState={{ selected: onlyToCheck }}
              onPress={onToCheck}
              style={{ minHeight: theme.size.minTouch, justifyContent: 'center' }}
            >
              <AppText color="warnText" variant="bodyStrong">
                {onlyToCheck ? t('exp.to_check_all') : t('exp.to_check', { n: b.review })}
              </AppText>
            </Pressable>
          ) : null}
        </View>
      )}
      {main && main.income > 0n ? (
        <AppText testID="exp-income" variant="meta" style={styles.right}>
          {t('exp.income', { amount: formatMinor(main.income, main.currency) })}
        </AppText>
      ) : null}
      {b.apart.length > 0 ? (
        <AppText testID="exp-apart" variant="meta" style={styles.right}>
          {t('exp.apart', { list: b.apart.map((x) => formatMinor(x.total, x.currency)).join(', ') })}
        </AppText>
      ) : null}
    </View>
  );
}

type SaveInput = { minor: bigint; expression: string | null; category: Category | null; day: string };

function useEntryState(today: string) {
  const sum = useSum();
  const [category, setCategory] = useState<Category | null>(null);
  const [day, setDay] = useState(today);
  const reset = () => {
    sum.setText('');
    setCategory(null);
    setDay(today);
  };
  const input = (): SaveInput | null =>
    sum.minor !== null ? { minor: sum.minor, expression: storedExpression(sum.text), category, day } : null;
  return { sum, category, setCategory, day, setDay, reset, input };
}

function InlineEntry({ today, chips, onSave, onFold }: { today: string; chips: Category[]; onSave: (x: SaveInput) => Promise<void>; onFold: (() => void) | null }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const st = useEntryState(today);
  return (
    <View style={{ backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.line, borderRadius: theme.radius.card, padding: theme.space[3], gap: theme.space[2] }}>
      <EntryPanel
        sum={st.sum}
        day={st.day}
        today={today}
        onDay={st.setDay}
        categories={chips}
        category={st.category?.key ?? null}
        onCategory={(c) => st.setCategory((prev) => (prev?.key === c.key ? null : c))}
        saveLabel={t('exp.save')}
        onSave={() => {
          const x = st.input();
          if (!x) return;
          st.reset();
          void onSave(x);
        }}
      />
      {onFold ? <Button testID="exp-fold" label={t('exp.close_entry')} variant="text" minHeight={theme.size.minTouch} onPress={onFold} /> : null}
    </View>
  );
}

/** ≥150%: the keys on the whole screen; the board and the feed stay below on the page. */
function FullEntry({ today, chips, onSave, onClose }: { today: string; chips: Category[]; onSave: (x: SaveInput) => Promise<void>; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const st = useEntryState(today);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView testID="exp-full-entry" style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        <FlatList
          data={[]}
          renderItem={() => null}
          ListHeaderComponent={
            <View style={{ padding: theme.screenPadding, gap: theme.space[3] }}>
              <Button testID="exp-full-close" label={t('exp.close_entry')} variant="text" minHeight={theme.size.minTouch} onPress={onClose} style={styles.start} />
              <EntryPanel
                sum={st.sum}
                day={st.day}
                today={today}
                onDay={st.setDay}
                categories={chips}
                category={st.category?.key ?? null}
                onCategory={(c) => st.setCategory((prev) => (prev?.key === c.key ? null : c))}
                saveLabel={t('exp.save')}
                onSave={() => {
                  const x = st.input();
                  if (x) void onSave(x);
                }}
              />
            </View>
          }
        />
      </SafeAreaView>
    </Modal>
  );
}

/** One line of the receipt: what, the category, the amount on the right (tabular), «⋯». */
function FeedLine({ e, today, marked, onMenu }: { e: ExpenseOut; today: string; marked: boolean; onMenu: () => void }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const server = useExpenses((s) => s.categories);
  const lang = i18n.language;
  const title = lineTitle(e, server, lang, t('exp.no_category'));
  const cat = categoryByKey(server, e.category_key);
  const catTitle = cat ? categoryTitle(cat, lang) : t('exp.no_category');
  const toCheck = e.review_fields.includes('amount');
  const minor = toMinor(e.amount) ?? 0n;
  const signed = e.direction === 'refund' ? -minor : minor;
  const spoken = spokenAmount(e.amount, e.currency);
  const label = t(toCheck ? 'exp.row_check_a11y' : 'exp.row_a11y', { amount: spoken, title, category: catTitle, day: dayLabel(e.spent_on, today, lang, t) });
  const waits = e.id.startsWith('local:');
  const from = sourceWord(e.source, t);
  const meta = [catTitle, from, waits ? t('exp.waits') : null].filter(Boolean).join(' · ');
  return (
    <View
      testID={`exp-row-${e.id}`}
      style={[
        styles.row,
        {
          alignItems: 'center',
          gap: theme.space[2],
          minHeight: theme.size.primaryTouch,
          paddingVertical: theme.space[2],
          paddingHorizontal: theme.space[1],
          backgroundColor: marked ? theme.colors.markerSoft : 'transparent',
          borderRadius: theme.radius.input,
          flexWrap: theme.largeFont ? 'wrap' : 'nowrap',
        },
      ]}
    >
      <View testID={`exp-row-label-${e.id}`} accessible accessibilityLabel={label} style={[styles.flex, { minWidth: theme.largeFont ? '60%' : undefined }]}>
        <AppText variant="bodyStrong">{title}</AppText>
        <AppText variant="meta">{meta}</AppText>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <AppText
          testID={`exp-row-amount-${e.id}`}
          variant="number"
          style={toCheck ? { backgroundColor: theme.colors.markerSoft, paddingHorizontal: theme.space[1], borderRadius: 4 } : undefined}
        >
          {formatMinor(signed, e.currency)}
        </AppText>
        {toCheck ? (
          <AppText variant="meta" color="warnText">
            {`⚠ ${t('exp.check')}`}
          </AppText>
        ) : null}
      </View>
      <Pressable
        testID={`exp-row-menu-${e.id}`}
        accessibilityRole="button"
        accessibilityLabel={t('exp.more_a11y', { title })}
        onPress={onMenu}
        style={{ width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' }}
      >
        <MoreHorizontal size={24} color={theme.colors.ink2} />
      </Pressable>
    </View>
  );
}

/** «⋯» of a spending: Категория on top (template-screens 3), the amount, the day, «Верно», «Удалить». */
function ExpenseSheet({
  e,
  today,
  chips,
  hasRecord,
  startEditing = false,
  onOpenRecord,
  onClose,
}: {
  e: ExpenseOut;
  today: string;
  chips: Category[];
  hasRecord: boolean;
  startEditing?: boolean;
  onOpenRecord: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const server = useExpenses((s) => s.categories);
  const [editing, setEditing] = useState(startEditing);
  const sum = useSum();
  const title = lineTitle(e, server, lang, t('exp.no_category'));
  const amount = formatMinor(toMinor(e.amount) ?? 0n, e.currency);
  const toCheck = e.review_fields.length > 0;
  return (
    <Sheet testID="exp-sheet" title={`${title} · ${amount}`} onClose={onClose}>
      {e.line_items && e.line_items.length > 0 ? (
        <View testID="exp-sheet-lines" style={{ gap: theme.space[1] }}>
          <AppText variant="section">{t('exp.sheet_lines')}</AppText>
          {e.line_items.map((l, i) => (
            <View key={`${i}:${l.name}`} style={[styles.row, { gap: theme.space[2] }]}>
              <AppText style={styles.flex}>{l.qty ? `${l.name} × ${l.qty}` : l.name}</AppText>
              {l.total ? <AppText variant="number">{formatMinor(toMinor(l.total) ?? 0n, e.currency)}</AppText> : null}
            </View>
          ))}
          {e.review_fields.includes('line_items') ? (
            <AppText color="warnText" variant="meta">
              {t('exp.sheet_lines_check')}
            </AppText>
          ) : null}
        </View>
      ) : null}
      {e.expression ? <AppText variant="meta">{t('exp.sheet_from', { expression: e.expression.replace(/-/g, '−') })}</AppText> : null}
      <AppText variant="section">{t('exp.sheet_category')}</AppText>
      <CategoryChips
        testID="exp-sheet-cat"
        categories={chips}
        value={e.category_key}
        onPick={(c) => {
          onClose();
          void changeExpense(e.id, { category_key: c.key, category_id: c.id }, t('exp.cat_set', { title, category: categoryTitle(c, lang) }));
        }}
      />
      <AppText variant="section">{t('exp.sheet_day')}</AppText>
      <DayChip
        testID="exp-sheet-day"
        value={e.spent_on}
        today={today}
        onChange={(d) => void changeExpense(e.id, { spent_on: d }, t('exp.day_set', { day: dayLabel(d, today, lang, t) }))}
      />
      {toCheck ? (
        <Button
          testID="exp-sheet-verify"
          label={t('exp.sheet_verify')}
          accessibilityHint={t('exp.sheet_verify_hint')}
          variant="outline"
          onPress={() => {
            onClose();
            void changeExpense(e.id, { review_fields: [] }, t('exp.verified', { amount }));
          }}
        />
      ) : null}
      {editing ? (
        <View style={{ gap: theme.space[3] }}>
          <SumDisplay testID="exp-sheet-sum" text={sum.text} />
          <ExpenseKeypad
            testID="exp-sheet-keypad"
            onKey={sum.onKey}
            canSave={sum.ok}
            saveLabel={t('exp.sheet_save_amount')}
            onSave={() => {
              const minor = sum.minor;
              if (minor === null) return;
              onClose();
              void changeExpense(
                e.id,
                { amount: minorToDecimal(minor), expression: storedExpression(sum.text), review_fields: e.review_fields.filter((f) => f !== 'amount') },
                t('exp.amount_set', { amount: formatMinor(minor, e.currency) }),
              );
            }}
          />
        </View>
      ) : (
        <Button testID="exp-sheet-amount" label={t('exp.sheet_amount')} variant="outline" onPress={() => setEditing(true)} />
      )}
      {hasRecord ? <Button testID="exp-sheet-open" label={t('exp.sheet_open')} variant="outline" onPress={onOpenRecord} /> : null}
      <Button
        testID="exp-sheet-delete"
        label={t('exp.sheet_delete')}
        variant="text"
        labelColor="alarm"
        onPress={() => {
          onClose();
          void deleteExpense(e.id, t('exp.deleted', { amount }));
        }}
      />
    </Sheet>
  );
}

/** «Порядок»: the chips with ↑ ↓; the first move makes the order the person's (expenses.md, rule 1). */
function CategoryOrder({ chips, pending }: { chips: Category[]; pending: string[] | null }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const keys = chips.map((c) => c.key);
  const manual = pending !== null || chips.some((c) => c.manual);
  const move = (i: number, step: -1 | 1) => {
    const j = i + step;
    if (j < 0 || j >= keys.length) return;
    const next = [...keys];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void reorderCategories(next, manual ? keys : null, t('exp.reordered'));
  };
  return (
    <View testID="exp-cat-order" style={{ gap: theme.space[2] }}>
      <AppText variant="meta">{t('exp.order_hint')}</AppText>
      {chips.map((c, i) => {
        const name = categoryTitle(c, i18n.language);
        return (
          <View key={c.key} style={[styles.row, { alignItems: 'center', gap: theme.space[2], minHeight: theme.size.minTouch }]}>
            <AppText testID={`exp-order-${i}`} style={styles.flex}>
              {name}
            </AppText>
            <Button
              testID={`exp-order-up-${c.key}`}
              label=""
              icon={<ArrowUp size={22} color={theme.colors.accent} />}
              accessibilityLabel={t('exp.cat_up_a11y', { title: name })}
              variant="outline"
              minHeight={theme.size.minTouch}
              disabled={i === 0}
              onPress={() => move(i, -1)}
            />
            <Button
              testID={`exp-order-down-${c.key}`}
              label=""
              icon={<ArrowDown size={22} color={theme.colors.accent} />}
              accessibilityLabel={t('exp.cat_down_a11y', { title: name })}
              variant="outline"
              minHeight={theme.size.minTouch}
              disabled={i === chips.length - 1}
              onPress={() => move(i, 1)}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  flex: { flex: 1 },
  right: { textAlign: 'right' },
  center: { textAlign: 'center' },
  start: { alignSelf: 'flex-start' },
  dash: { borderTopWidth: 1, borderStyle: 'dashed', height: 1 },
  dashTop: { borderTopWidth: 1, borderStyle: 'dashed' },
});
