import { router } from 'expo-router';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Plus } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';

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
import { readableColumn, useLayout, useTheme } from '@/theme';

import { AmountText } from '../AmountText';
import { AppText } from '../AppText';
import { RecordRow } from '../RecordRow';
import { useMinuteClock } from '../ReminderLists';
import { Button } from '../ui/Button';
import { ActionList } from '../ui/Sheet';
import { Card } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { pressedStyle } from '../ui/motion';
import { SegmentedControl } from '../ui/SegmentedControl';
import { categoryLook } from './expenseColors';
import { AttentionCard, AttentionSheet, attentionItems, BringButton, sourceWord, useBringKinds } from './ExpenseInbox';
import { CategoryChips, CategoryDot, DayChip, EntryPanel, Sheet, SumDisplay, useSum } from './ExpenseParts';
import { ExpenseKeypad } from './ExpenseKeypad';
import type { ViewProps } from './registry';

/** «По категориям»: the top rows under the stacked bar (pattern 4); the rest behind «Все категории». */
export const TOP_CATEGORIES = 5;
/** How often «Читаю чек…» wakes the outbox while the page is open. */
const READ_POLL_MS = 3000;
/** The new line is marked this long. */
const MARK_MS = 600;

type Kind = 'week' | 'month' | 'year';

/**
 * «Расходы» (research/expenses-documents.md, patterns 1–6; screens.html «Расходы»). One big total for the
 * period with no box (counted by code in tiyn, the same rules as the server's `calc.py`), one «Требует
 * внимания» card for everything to check / merge / read, the categories as a colour system (stacked bar + top
 * rows, icon = bar = segment colour), the feed by day in cards. «Записать трату» opens the keys in a sheet
 * (tap a category = the same sheet with it picked). Everything works offline and in «Без ИИ».
 * ≥840: overview on the left, the feed on the right.
 */
export function ExpensesView({ page, entries, frameTop, ordering }: ViewProps) {
  const theme = useTheme();
  const layout = useLayout();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const today = localDate(useMinuteClock());
  const stored = useExpenses((s) => s.entries);
  const edits = useExpenses((s) => s.edits);
  const server = useExpenses((s) => s.categories);
  const orderEdit = useExpenses((s) => s.orderEdit);
  const kinds = useBringKinds();
  const [kind, setKind] = useState<Kind>('month');
  const [period, setPeriod] = useState<Period>(() => periodOf('month', today));
  const [onlyToCheck, setOnlyToCheck] = useState(false);
  const [entry, setEntry] = useState<{ category: Category | null } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [marked, setMarked] = useState<string | null>(null);
  const [kaspi, setKaspi] = useState(false);
  const [editFirst, setEditFirst] = useState(false);
  const [attention, setAttention] = useState(false);
  const [allBars, setAllBars] = useState(false);
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
  const queue = useMemo(
    () => attentionItems({ jobs: shownJobs, toCheck, pairs, plans, statements: kinds.statements, qr: kinds.qr }),
    [shownJobs, toCheck, pairs, plans, kinds.statements, kinds.qr],
  );
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
  const openEntry = (category: Category | null = null) => {
    setAttention(false);
    setEntry({ category });
  };

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

  const shownBars = allBars ? catBars : catBars.slice(0, TOP_CATEGORIES);
  const overview = (
    <View style={{ gap: theme.space[4] }}>
      <SegmentedControl
        testID="exp-periods"
        accessibilityLabel={t('exp.periods_a11y')}
        segments={(['week', 'month', 'year'] as const).map((k) => ({ key: k, label: t(`exp.period_${k}`), testID: `exp-period-${k}` }))}
        value={kind}
        onChange={pick}
      />
      <Overview
        title={periodTitle(period, lang)}
        board={b}
        onShift={(step) => setPeriod((p) => shiftPeriod(p, step))}
        canNext={(period.to ?? today) < today}
        onlyToCheck={onlyToCheck}
        onToCheck={() => setOnlyToCheck((v) => !v)}
      />
      <AttentionCard items={queue} onOpen={() => setAttention(true)} />
      {ordering ? <CategoryOrder chips={chips} pending={orderEdit?.keys ?? null} /> : null}
      {empty ? (
        <View style={{ gap: theme.space[2] }}>
          <AppText testID="exp-or-say" color="ink2">
            {t('exp.empty_hint')}
          </AppText>
          {kinds.statements ? (
            <Button testID="exp-kaspi" label={t('exp.kaspi_link')} variant="text" onPress={() => setKaspi(true)} style={styles.start} />
          ) : null}
        </View>
      ) : null}
      {catBars.length > 0 ? (
        <View testID="exp-bars" style={{ gap: theme.space[2] }}>
          <AppText variant="sectionLabel" accessibilityRole="header">
            {t('exp.by_category')}
          </AppText>
          <View
            testID="exp-stack"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ flexDirection: 'row', minHeight: 12, borderRadius: 6, overflow: 'hidden', gap: 2, backgroundColor: theme.colors.surfaceSunken }}
          >
            {catBars.map((bar) => (
              <View key={bar.key || 'none'} style={{ flexGrow: Math.max(1, bar.share), flexBasis: 0, backgroundColor: categoryLook(theme, bar.key || null).color }} />
            ))}
          </View>
          <Card padded={false}>
            {shownBars.map((bar, i) => {
              const cat = categoryByKey(server, bar.key || null);
              const chip = cat ? (chips.find((c) => c.key === cat.key) ?? null) : null;
              const look = categoryLook(theme, bar.key || null);
              return (
                <Pressable
                  key={bar.key || 'none'}
                  testID={`exp-bar-${bar.key || 'none'}`}
                  accessibilityRole="button"
                  accessibilityLabel={t('exp.by_category_a11y', { title: bar.title, amount: formatMinor(bar.minor), share: Math.round(bar.share) })}
                  accessibilityHint={t('exp.bar_hint')}
                  onPress={() => openEntry(chip)}
                  style={({ pressed }) => [
                    styles.rowCenter,
                    { gap: theme.space[3], paddingLeft: theme.space[3] + 2, minHeight: theme.size.rowHeight },
                    pressed ? { backgroundColor: theme.colors.surfaceSunken } : null,
                  ]}
                >
                  <CategoryDot categoryKey={bar.key || null} size={32} />
                  <View
                    style={[
                      styles.rowCenter,
                      styles.flex,
                      { gap: theme.space[2], paddingRight: theme.space[3], paddingVertical: theme.space[2], flexWrap: theme.largeFont ? 'wrap' : 'nowrap' },
                      i < shownBars.length - 1 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.separator } : null,
                    ]}
                  >
                    <View style={[styles.flex, { gap: 4, minWidth: theme.largeFont ? '60%' : undefined }]}>
                      <AppText>{bar.title}</AppText>
                      <View style={{ height: 4, borderRadius: 2, backgroundColor: look.tint, overflow: 'hidden' }}>
                        <View style={{ width: `${Math.max(2, bar.share)}%`, height: 4, backgroundColor: look.color }} />
                      </View>
                    </View>
                    <AppText testID={`exp-bar-amount-${bar.key || 'none'}`} variant="number">
                      {formatMinor(bar.minor)}
                    </AppText>
                  </View>
                </Pressable>
              );
            })}
          </Card>
          {catBars.length > TOP_CATEGORIES ? (
            <Button
              testID="exp-bars-all"
              label={allBars ? t('exp.bars_less') : t('exp.bars_all', { count: catBars.length })}
              variant="text"
              style={styles.start}
              onPress={() => setAllBars((v) => !v)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );

  const feedTitle = (
    <View style={{ gap: theme.space[2] }}>
      <AppText variant="sectionLabel" accessibilityRole="header">
        {t('exp.feed')}
      </AppText>
      {days.length === 0 && !empty ? <AppText testID="exp-feed-none" color="ink2">{t('exp.feed_none')}</AppText> : null}
    </View>
  );

  const renderDay = ({ item }: { item: FeedDay }) => (
    <View style={{ gap: theme.space[2], paddingTop: theme.space[4] }}>
      <View testID={`exp-day-${item.date}`} style={[styles.rowCenter, { gap: theme.space[2], paddingHorizontal: theme.space[1], flexWrap: 'wrap' }]}>
        <AppText variant="sectionLabel" accessibilityRole="header" style={styles.flex}>
          {dayLabel(item.date, today, lang, t)}
        </AppText>
        <AppText testID={`exp-day-total-${item.date}`} variant="callout" accessibilityLabel={t('exp.day_total', { amount: formatMinor(item.total) })} style={styles.tabular}>
          {formatMinor(item.total)}
        </AppText>
      </View>
      <Card padded={false}>
        {item.entries.map((e, i) => (
          <FeedLine
            key={e.id}
            e={e}
            today={today}
            last={i === item.entries.length - 1}
            marked={marked === e.id || marked === `local:${e.client_id}`}
            onOpen={() => setMenu(e.id)}
          />
        ))}
      </Card>
    </View>
  );

  // Records on the page that are not a spending (moved here, a voice not read yet, a phrase saved as a note): still shown.
  const expenseItems = new Set(Object.values(stored).map((e) => e.item_id).filter((x): x is string => !!x));
  const others = (entries ?? []).filter((x) => x.record.deletedAt === null && !(x.record.serverId && expenseItems.has(x.record.serverId)));
  const footer =
    others.length > 0 ? (
      <View testID="exp-others" style={{ gap: theme.space[2], paddingTop: theme.space[6] }}>
        <AppText variant="sectionLabel" accessibilityRole="header">
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
  const column = { ...readableColumn(), paddingHorizontal: layout.gutter };
  const two = layout.twoPane;

  const list = (
    <FlatList
      testID="exp-list"
      data={days}
      keyExtractor={(d) => d.date}
      renderItem={renderDay}
      ListHeaderComponent={
        <View style={{ gap: theme.space[4] }}>
          {two ? null : (
            <>
              {frameTop}
              {overview}
            </>
          )}
          {feedTitle}
        </View>
      }
      ListFooterComponent={footer ?? undefined}
      contentContainerStyle={[column, { paddingTop: theme.space[4], paddingBottom: theme.space[6] }]}
      keyboardShouldPersistTaps="handled"
    />
  );

  return (
    <View style={styles.flex}>
      {two ? (
        <View style={[styles.row, styles.flex]}>
          <ScrollView testID="exp-overview-pane" style={{ flex: 1 }} contentContainerStyle={[column, { paddingTop: theme.space[4], paddingBottom: theme.space[6], gap: theme.space[4] }]}>
            {frameTop}
            {overview}
          </ScrollView>
          <View testID="exp-feed-pane" style={styles.flex}>
            {list}
          </View>
        </View>
      ) : (
        list
      )}
      <View
        testID="exp-actions"
        style={[styles.row, readableColumn(), { gap: theme.space[2], paddingHorizontal: layout.gutter, paddingVertical: theme.space[2], flexWrap: theme.largeFont ? 'wrap' : 'nowrap' }]}
      >
        <Button
          testID="exp-enter"
          label={t('exp.enter')}
          icon={<Icon icon={Plus} size="sm" color="onBrand" />}
          style={theme.largeFont ? { flexBasis: '100%' } : styles.flex}
          onPress={() => openEntry()}
        />
        <BringButton pageId={page.id} style={theme.largeFont ? { flexBasis: '100%' } : undefined} />
      </View>
      {entry ? (
        <EntrySheet
          today={today}
          chips={chips}
          initial={entry.category}
          onClose={() => setEntry(null)}
          onSave={async (x) => {
            setEntry(null);
            await save(x);
          }}
        />
      ) : null}
      {attention ? (
        <AttentionSheet
          items={queue}
          today={today}
          onClose={() => setAttention(false)}
          onType={() => openEntry()}
          onVerify={(e) =>
            void changeExpense(
              e.id,
              { review_fields: e.review_fields.filter((f) => f !== 'amount' && f !== 'spent_on') },
              t('exp.verified', { amount: formatMinor(toMinor(e.amount) ?? 0n, e.currency) }),
            )
          }
          onEdit={(e) => {
            setAttention(false);
            setEditFirst(true);
            setMenu(e.id);
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
    </View>
  );
}

/** Pattern 1: «‹ Ноябрь ›», the total 40 with no box, one context line «23 траты · ⚠ проверить 2». */
function Overview({
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
  const arrow = (step: -1 | 1) => {
    const off = step > 0 && !canNext;
    return (
      <Pressable
        testID={step < 0 ? 'exp-prev' : 'exp-next'}
        accessibilityRole="button"
        accessibilityLabel={t(step < 0 ? 'exp.prev_a11y' : 'exp.next_a11y')}
        accessibilityState={{ disabled: off }}
        disabled={off}
        onPress={() => onShift(step)}
        style={({ pressed }) => [{ width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center', opacity: off ? 0.35 : 1 }, pressedStyle(pressed)]}
      >
        <Icon icon={step < 0 ? ChevronLeft : ChevronRight} color="brand" />
      </Pressable>
    );
  };
  return (
    <View testID="exp-board" style={{ gap: theme.space[1] }}>
      <View style={styles.rowCenter}>
        {arrow(-1)}
        <AppText testID="exp-period-title" variant="headline" accessibilityRole="header" style={[styles.flex, styles.center]}>
          {title}
        </AppText>
        {arrow(1)}
      </View>
      <AmountText
        testID="exp-total"
        variant="amount"
        maxScale={1.6}
        inset={theme.screenPadding * 2}
        accessibilityLabel={t('exp.total_a11y', { period: title, amount: spokenAmount(minorToDecimal(spent), currency) })}
        accessibilityLiveRegion="polite"
        style={styles.center}
      >
        {amount}
      </AmountText>
      {!main || main.count === 0 ? (
        <AppText testID="exp-empty-total" variant="callout" style={styles.center}>
          {t('exp.empty_total')}
        </AppText>
      ) : (
        <View style={[styles.rowCenter, { justifyContent: 'center', flexWrap: 'wrap', columnGap: theme.space[2] }]}>
          <AppText testID="exp-count" variant="callout">
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
              <AppText color="warning" variant="callout" style={{ fontFamily: theme.type.sectionLabel.fontFamily }}>
                {onlyToCheck ? t('exp.to_check_all') : `· ${t('exp.to_check', { n: b.review })} ›`}
              </AppText>
            </Pressable>
          ) : null}
        </View>
      )}
      {main && main.income > 0n ? (
        <AppText testID="exp-income" variant="callout" style={styles.center}>
          {t('exp.income', { amount: formatMinor(main.income, main.currency) })}
        </AppText>
      ) : null}
      {b.apart.length > 0 ? (
        <AppText testID="exp-apart" variant="callout" style={styles.center}>
          {t('exp.apart', { list: b.apart.map((x) => formatMinor(x.total, x.currency)).join(', ') })}
        </AppText>
      ) : null}
    </View>
  );
}

type SaveInput = { minor: bigint; expression: string | null; category: Category | null; day: string };

/** Pattern 2: «Записать трату» → the sheet: the sum 40, the categories in one row, «Сегодня ▾», the keys. */
function EntrySheet({
  today,
  chips,
  initial,
  onSave,
  onClose,
}: {
  today: string;
  chips: Category[];
  initial: Category | null;
  onSave: (x: SaveInput) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const sum = useSum();
  const [category, setCategory] = useState<Category | null>(initial);
  const [day, setDay] = useState(today);
  return (
    <Sheet testID="exp-entry-sheet" title={t('exp.entry_title')} onClose={onClose}>
      <EntryPanel
        sum={sum}
        day={day}
        today={today}
        onDay={setDay}
        categories={chips}
        category={category?.key ?? null}
        onCategory={(c) => setCategory((prev) => (prev?.key === c.key ? null : c))}
        saveLabel={t('exp.save')}
        onSave={() => {
          if (sum.minor === null) return;
          void onSave({ minor: sum.minor, expression: storedExpression(sum.text), category, day });
        }}
      />
    </Sheet>
  );
}

/** Pattern 5: one row of the feed (≥56): the category circle, what + category, the amount; a tap opens it. */
function FeedLine({ e, today, last, marked, onOpen }: { e: ExpenseOut; today: string; last: boolean; marked: boolean; onOpen: () => void }) {
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
    <Pressable
      testID={`exp-row-${e.id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t('exp.row_hint')}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.rowCenter,
        {
          gap: theme.space[3],
          paddingLeft: theme.space[3] + 2,
          minHeight: 56,
          backgroundColor: marked ? theme.colors.highlightTint : pressed ? theme.colors.surfaceSunken : 'transparent',
        },
      ]}
    >
      <CategoryDot categoryKey={e.category_key} />
      <View
        style={[
          styles.rowCenter,
          styles.flex,
          { gap: theme.space[2], paddingVertical: theme.space[2], paddingRight: theme.space[3], flexWrap: theme.largeFont ? 'wrap' : 'nowrap' },
          last ? null : { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.separator },
        ]}
      >
        <View style={[styles.flex, { minWidth: theme.largeFont ? '60%' : undefined }]}>
          <AppText>{title}</AppText>
          <AppText variant="callout">{meta}</AppText>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <AppText
            testID={`exp-row-amount-${e.id}`}
            variant="number"
            color={e.direction === 'refund' ? 'success' : 'ink'}
            style={toCheck ? { backgroundColor: theme.colors.highlightTint, paddingHorizontal: theme.space[1], borderRadius: 4 } : undefined}
          >
            {formatMinor(signed, e.currency)}
          </AppText>
          {toCheck ? (
            <AppText variant="footnote" color="warning">
              {t('exp.check')}
            </AppText>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** A spending opened: the amount, Категория on top (template-screens 3), the day, then the actions as rows. */
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
        <View testID="exp-sheet-lines" style={{ gap: theme.space[1], backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.md, padding: theme.space[3] }}>
          <AppText variant="sectionLabel">{t('exp.sheet_lines')}</AppText>
          {e.line_items.map((l, i) => (
            <View key={`${i}:${l.name}`} style={[styles.row, { gap: theme.space[2] }]}>
              <AppText variant="callout" color="ink" style={styles.flex}>
                {l.qty ? `${l.name} × ${l.qty}` : l.name}
              </AppText>
              {l.total ? <AppText variant="number">{formatMinor(toMinor(l.total) ?? 0n, e.currency)}</AppText> : null}
            </View>
          ))}
          {e.review_fields.includes('line_items') ? (
            <AppText color="warning" variant="callout">
              {t('exp.sheet_lines_check')}
            </AppText>
          ) : null}
        </View>
      ) : null}
      {e.expression ? <AppText variant="callout">{t('exp.sheet_from', { expression: e.expression.replace(/-/g, '−') })}</AppText> : null}
      <AppText variant="sectionLabel">{t('exp.sheet_category')}</AppText>
      <CategoryChips
        testID="exp-sheet-cat"
        categories={chips}
        value={e.category_key}
        onPick={(c) => {
          onClose();
          void changeExpense(e.id, { category_key: c.key, category_id: c.id }, t('exp.cat_set', { title, category: categoryTitle(c, lang) }));
        }}
      />
      <AppText variant="sectionLabel">{t('exp.sheet_day')}</AppText>
      <DayChip
        testID="exp-sheet-day"
        value={e.spent_on}
        today={today}
        onChange={(d) => void changeExpense(e.id, { spent_on: d }, t('exp.day_set', { day: dayLabel(d, today, lang, t) }))}
      />
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
      ) : null}
      <ActionList
        actions={[
          ...(toCheck
            ? [
                {
                  key: 'verify',
                  testID: 'exp-sheet-verify',
                  label: t('exp.sheet_verify'),
                  hint: t('exp.sheet_verify_hint'),
                  onPress: () => {
                    onClose();
                    void changeExpense(e.id, { review_fields: [] }, t('exp.verified', { amount }));
                  },
                },
              ]
            : []),
          ...(editing ? [] : [{ key: 'amount', testID: 'exp-sheet-amount', label: t('exp.sheet_amount'), onPress: () => setEditing(true) }]),
          ...(hasRecord ? [{ key: 'open', testID: 'exp-sheet-open', label: t('exp.sheet_open'), onPress: onOpenRecord }] : []),
          {
            key: 'delete',
            testID: 'exp-sheet-delete',
            label: t('exp.sheet_delete'),
            danger: true,
            onPress: () => {
              onClose();
              void deleteExpense(e.id, t('exp.deleted', { amount }));
            },
          },
        ]}
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
  const arrow = (c: Category, i: number, step: -1 | 1, name: string) => {
    const off = step < 0 ? i === 0 : i === chips.length - 1;
    return (
      <Pressable
        testID={`exp-order-${step < 0 ? 'up' : 'down'}-${c.key}`}
        accessibilityRole="button"
        accessibilityLabel={t(step < 0 ? 'exp.cat_up_a11y' : 'exp.cat_down_a11y', { title: name })}
        accessibilityState={{ disabled: off }}
        disabled={off}
        onPress={() => move(i, step)}
        style={({ pressed }) => [{ width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center', opacity: off ? 0.35 : 1 }, pressedStyle(pressed)]}
      >
        <Icon icon={step < 0 ? ArrowUp : ArrowDown} size="sm" color="brand" />
      </Pressable>
    );
  };
  return (
    <View testID="exp-cat-order" style={{ gap: theme.space[2] }}>
      <AppText variant="callout">{t('exp.order_hint')}</AppText>
      <Card padded={false}>
        {chips.map((c, i) => {
          const name = categoryTitle(c, i18n.language);
          return (
            <View key={c.key} style={[styles.rowCenter, { gap: theme.space[2], minHeight: theme.size.rowHeight, paddingLeft: theme.space[3] + 2 }]}>
              <CategoryDot categoryKey={c.key} size={28} />
              <AppText testID={`exp-order-${i}`} style={styles.flex}>
                {name}
              </AppText>
              {arrow(c, i, -1, name)}
              {arrow(c, i, 1, name)}
            </View>
          );
        })}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  start: { alignSelf: 'flex-start' },
  tabular: { fontVariant: ['tabular-nums'] },
});
