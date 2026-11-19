import { router } from 'expo-router';
import { ArrowDown, ArrowUp, ChevronDown, Plus } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Defs, Path, Pattern, Rect } from 'react-native-svg';

import { clockOf } from '@/alarms/format';
import type { ExpenseOut } from '@/api/types';
import { formatMinor, inPeriod, minorToDecimal, periodOf, shiftPeriod, toMinor, type Period } from '@/expenses/calc';
import { categoryByKey, categoryTitle, chipCategories, orderedCategories, type Category } from '@/expenses/categories';
import { storedExpression } from '@/expenses/expression';
import { bars, board, dayLabel, feed, lineTitle, liveEntries, periodTitle, spokenAmount, type FeedDay } from '@/expenses/feed';
import { proposedStatements, refreshDuplicates, refreshStatements, visibleDuplicates, visibleJobs } from '@/expenses/receipts';
import { addExpense, changeExpense, deleteExpense, reorderCategories } from '@/expenses/service';
import { useExpenses } from '@/expenses/store';
import { pullBudget } from '@/expenses/budget';
import { budgetMinor, useBudget } from '@/store/budget';
import { useChrome } from '@/store/chrome';
import { useView } from '@/store/view';
import { kickSync, syncBlocked } from '@/services';
import { localDate } from '@/tasks/rows';
import { readableColumn, useLayout, useTheme } from '@/theme';
import { ChangedMark } from '@/components/ChangedMark';

import { AppText } from '../AppText';
import { RecordRow } from '../RecordRow';
import { useMinuteClock } from '../ReminderLists';
import { Button } from '../ui/Button';
import { ActionList } from '../ui/Sheet';
import { Bar, BigNumber, CategorySquare, Row, RowMeta } from '../ui/Leaf';
import { AnimatedList, scaledLine, usePlaceList } from '../ui/PlaceScreen';
import { useSheetSlot } from './PageFrame';
import { Card } from '../ui/Card';
import { Chip } from '../ui/Chip';
import { Icon } from '../ui/Icon';
import { pressedStyle } from '../ui/motion';
import { SegmentedControl } from '../ui/SegmentedControl';
import { categoryLook } from './expenseColors';
import { AttentionCard, AttentionSheet, attentionItems, sourceWord, useBringKinds } from './ExpenseInbox';
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
  const [periodOpen, setPeriodOpen] = useState(false);
  // «Порядок категорий» lives in the period sheet (QA v2 §3.7: no ⋯ on «Расходы»).
  const [ordering2, setOrdering2] = useState(false);
  const jobs = useExpenses((s) => s.jobs);
  const statements = useExpenses((s) => s.statements);
  const duplicates = useExpenses((s) => s.duplicates);
  const decided = useExpenses((s) => s.decided);

  // Week 13: «Объединить?» pairs and plans the server has now (online; offline the phone's copies stay).
  useEffect(() => {
    void refreshDuplicates();
    void refreshStatements();
    void pullBudget();
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

  // design-system v2 TabBar: a second tap on «Расходы» while this page is open opens the keypad.
  const keypadRequest = useView((s) => s.keypadRequest);
  const [seenRequest, setSeenRequest] = useState(keypadRequest);
  if (seenRequest !== keypadRequest) {
    setSeenRequest(keypadRequest);
    if (!entry) setEntry({ category: null });
  }
  const budget = useBudget(budgetMinor);
  const thisMonth = kind === 'month' && period.from === periodOf('month', today).from;

  const ovProps: OverviewProps = {
    onPeriod: () => setPeriodOpen(true),
    title: periodTitle(period, lang),
    board: b,
    budget: thisMonth ? budget : null,
    today,
    period,
    onlyToCheck,
    onToCheck: () => setOnlyToCheck((v) => !v),
  };
  const ovSheet = useOverviewSheet(ovProps);
  // screens-v5 «Расходы · категория» / «Чек»: sub-screens of the page, the sheet collapsed to «‹ Расходы».
  const [sub, setSub] = useState<{ kind: 'category'; key: string } | { kind: 'receipt'; id: string } | null>(null);
  const subBar = sub?.kind === 'category' ? (catBars.find((x) => (x.key || '') === sub.key) ?? null) : null;
  const subCat = sub?.kind === 'category' ? categoryByKey(server, sub.key || null) : null;
  const subChip = subCat ? (chips.find((c) => c.key === subCat.key) ?? null) : null;
  const receipt = sub?.kind === 'receipt' ? (live.find((e) => e.id === sub.id) ?? null) : null;
  const backToMonth = { label: t('tpl.short.expenses'), onPress: () => setSub(null), testID: 'exp-sub-back' };
  const slot =
    sub?.kind === 'category'
      ? {
          strip: {
            title: subBar?.title ?? t('exp.no_category'),
            back: backToMonth,
            actions: [{ key: 'add', testID: 'exp-sub-add', icon: Plus, label: t('exp.new_expense'), onPress: () => openEntry(subChip) }],
          },
        }
      : sub?.kind === 'receipt'
        ? { strip: { title: t('exp.receipt'), back: backToMonth } }
        : { metaNode: ovSheet.metaNode, sheetExtra: ovSheet.sheetExtra, sheetExtraHeight: ovSheet.height, hideTitle: true };
  useSheetSlot(slot, sub ? `${sub.kind}:${sub.kind === 'category' ? sub.key : sub.id}:${subBar?.title ?? ''}` : ovSheet.key);
  const askHint = sub?.kind === 'category' ? t('ask.category', { category: subBar?.title ?? '' }) : sub?.kind === 'receipt' ? t('ask.receipt') : null;
  useEffect(() => {
    useChrome.getState().setAskHint(askHint);
  }, [askHint]);
  useEffect(() => () => useChrome.getState().setAskHint(null), []);
  // The sub-screen of something that went away (deleted, another period) closes.
  if (sub && ((sub.kind === 'category' && !subBar) || (sub.kind === 'receipt' && !receipt))) setSub(null);
  const listRef = useRef<FlatList<FeedDay>>(null);
  const place = usePlaceList((y, animated) => listRef.current?.scrollToOffset({ offset: y, animated }));

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
      <OverviewPaper {...ovProps} />
      <AttentionCard items={queue} onOpen={() => setAttention(true)} />
      {ordering || ordering2 ? (
        <View style={{ gap: theme.space[2] }}>
          <CategoryOrder chips={chips} pending={orderEdit?.keys ?? null} />
          {ordering2 ? <Button testID="exp-order-done" label={t('page.order_done')} size="small" onPress={() => setOrdering2(false)} style={styles.start} /> : null}
        </View>
      ) : null}
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
          <View style={[styles.rowCenter, { gap: theme.space[2] }]}>
            <AppText variant="sectionLabel" accessibilityRole="header" style={styles.flex}>
              {t('exp.by_category')}
            </AppText>
            {budget !== null ? (
              <AppText testID="exp-budget-note" variant="footnote">
                {t('budget.link')}
              </AppText>
            ) : null}
          </View>
          {/* The categories in scale (the colour is only the segment and the 12 dp square), the hatch = what is left. */}
          <View testID="exp-tiles" style={{ flexDirection: 'row', gap: 3, height: 30 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {catBars.map((bar) => (
              <View key={bar.key || 'none'} style={{ flex: Math.max(0.5, bar.share), backgroundColor: categoryLook(theme, bar.key || null).color, borderRadius: 6 }} />
            ))}
            {thisMonth && budget !== null && b.main && budget > b.main.total && b.main.total > 0n ? (
              <View style={{ flex: Number(((budget - b.main.total) * 1000n) / b.main.total) / 10, borderRadius: 6, borderWidth: 1.5, borderColor: theme.colors.line2, borderStyle: 'dashed' }} />
            ) : null}
          </View>
          <View style={{ height: 10 }} />
          <View>
            {shownBars.map((bar, i) => {
              const cat = categoryByKey(server, bar.key || null);
              const chip = cat ? (chips.find((c) => c.key === cat.key) ?? null) : null;
              const look = categoryLook(theme, bar.key || null);
              return (
                <Row
                  key={bar.key || 'none'}
                  first={i === 0}
                  testID={`exp-bar-${bar.key || 'none'}`}
                  accessibilityLabel={`${bar.title}: ${formatMinor(bar.minor)}, ${t('exp.share_of_all', { n: Math.round(bar.share) })}`}
                  onPress={() => (chip || bar.key ? setSub({ kind: 'category', key: bar.key || '' }) : openEntry(chip))}
                >
                  <CategorySquare color={look.color} />
                  <AppText numberOfLines={1} style={styles.flex}>
                    {bar.title}
                  </AppText>
                  <AppText variant="number">{bareSum(formatMinor(bar.minor))}</AppText>
                </Row>
              );
            })}
          </View>
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
    <View>
      <View testID={`exp-day-${item.date}`} style={[styles.rowCenter, { gap: theme.space[2], marginTop: 18, marginBottom: 6, flexWrap: 'wrap' }]}>
        <AppText variant="section" accessibilityRole="header" style={styles.flex}>
          {dayLabel(item.date, today, lang, t)}
        </AppText>
        <AppText testID={`exp-day-total-${item.date}`} variant="small" color="ink3" accessibilityLabel={t('exp.day_total', { amount: formatMinor(item.total) })} style={styles.tabular}>
          {bareSum(formatMinor(item.total))}
        </AppText>
      </View>
      <View>
        {item.entries.map((e, i) => (
          <FeedLine
            key={e.id}
            e={e}
            today={today}
            first={i === 0}
            marked={marked === e.id || marked === `local:${e.client_id}`}
            onOpen={() => setMenu(e.id)}
          />
        ))}
      </View>
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
  const subDays = sub?.kind === 'category'
    ? days
        .map((d) => {
          const entries2 = d.entries.filter((e) => (e.category_key ?? '') === sub.key);
          const total = entries2.reduce((acc, e) => acc + (toMinor(e.amount) ?? 0n) * (e.direction === 'refund' ? -1n : 1n), 0n);
          return { ...d, entries: entries2, total };
        })
        .filter((d) => d.entries.length > 0)
    : days;
  const recordOf = (e: ExpenseOut) => (entries ?? []).find((x) => x.record.serverId && x.record.serverId === e.item_id)?.record ?? null;
  const column = { ...readableColumn() };
  const two = layout.twoPane;

  const list = (
    <AnimatedList
      ref={listRef}
      testID="exp-list"
      data={sub?.kind === 'receipt' ? [] : sub?.kind === 'category' ? subDays : days}
      keyExtractor={(d) => d.date}
      renderItem={renderDay}
      ListHeaderComponent={
        receipt ? (
          <ReceiptView e={receipt} today={today} onCategory={() => setMenu(receipt.id)} />
        ) : subBar ? (
          <CategoryHead
            title={subBar.title}
            period={periodTitle(period, lang)}
            minor={subBar.minor}
            share={subBar.share}
            color={categoryLook(theme, subBar.key || null).color}
          />
        ) : (
        <View style={{ gap: theme.space[4] }}>
          {two ? null : (
            <>
              {frameTop}
              {overview}
            </>
          )}
          {feedTitle}
        </View>
        )
      }
      ListFooterComponent={sub ? undefined : (footer ?? undefined)}
      contentContainerStyle={[column, { paddingTop: place ? place.inset : theme.space[4], paddingBottom: theme.m.ask.listBottomPadding + theme.space[2] }]}
      onScroll={place?.onScroll}
      onScrollEndDrag={place?.onScrollEndDrag}
      onMomentumScrollEnd={place?.onMomentumScrollEnd}
      scrollEventThrottle={place?.scrollEventThrottle}
      keyboardShouldPersistTaps="handled"
    />
  );

  return (
    <View style={styles.flex}>
      {two ? (
        <View style={[styles.row, styles.flex]}>
          <ScrollView testID="exp-overview-pane" style={{ flex: 1 }} contentContainerStyle={[column, { paddingTop: theme.space[4], paddingBottom: theme.size.contentEndGap, gap: theme.space[4] }]}>
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
      {periodOpen ? (
        <Sheet testID="exp-period-sheet" title={t('exp.period_title')} onClose={() => setPeriodOpen(false)}>
          <SegmentedControl
            testID="exp-periods"
            accessibilityLabel={t('exp.periods_a11y')}
            segments={(['week', 'month', 'year'] as const).map((k) => ({ key: k, label: t(`exp.period_${k}`), testID: `exp-period-${k}` }))}
            value={kind}
            onChange={pick}
          />
          <View style={[styles.rowCenter, { justifyContent: 'space-between' }]}>
            <Button testID="exp-prev" label={`‹ ${t('exp.prev')}`} variant="text" onPress={() => setPeriod((p) => shiftPeriod(p, -1))} />
            <AppText testID="exp-period-title" variant="headline" accessibilityRole="header">
              {periodTitle(period, lang)}
            </AppText>
            <Button
              testID="exp-next"
              label={`${t('exp.next')} ›`}
              variant="text"
              disabled={!((period.to ?? today) < today)}
              onPress={() => setPeriod((p) => shiftPeriod(p, 1))}
            />
          </View>
          <Button
            testID="exp-order-open"
            label={t('exp.order_categories')}
            variant="text"
            onPress={() => {
              setPeriodOpen(false);
              setOrdering2(true);
            }}
          />
        </Sheet>
      ) : null}
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
          onOpenReceipt={
            (menuEntry.line_items?.length ?? 0) > 0 && sub?.kind !== 'receipt'
              ? () => {
                  setMenu(null);
                  setSub({ kind: 'receipt', id: menuEntry.id });
                }
              : undefined
          }
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

/**
 * screens-v5 «Расходы · категория»: the green sheet collapsed «‹ Расходы · Транспорт»; on the paper «■ Транспорт ·
 * ноябрь», the ONE big number, its share of the month, a bar in the category colour; then its days.
 */
function CategoryHead({ title, period, minor, share, color }: { title: string; period: string; minor: bigint; share: number; color: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID="exp-category">
      <View style={[styles.rowCenter, { gap: 8 }]}>
        <CategorySquare color={color} />
        <AppText variant="footnote">{`${title} · ${period}`}</AppText>
      </View>
      <View style={{ marginTop: 8 }}>
        <BigNumber testID="exp-category-total" value={bareSum(formatMinor(minor))} currency="₸" />
      </View>
      <AppText variant="small" style={{ marginTop: 6 }}>
        {t('exp.share_of_all', { n: Math.round(share) })}
      </AppText>
      <View style={{ marginTop: 12 }}>
        <Bar value={share / 100} height={10} color={color} track={theme.colors.paper2} />
      </View>
    </View>
  );
}

/**
 * screens-v5 «Расходы · чек»: the total as the one big number with its category chip, «Вчера, 19:20 · из фото чека ·
 * 7 позиций», the receipt as a paper tape on `paper2` (tabular lines, a dashed «Итого», a torn edge).
 */
function ReceiptView({ e, today, onCategory }: { e: ExpenseOut; today: string; onCategory: () => void }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const server = useExpenses((s) => s.categories);
  const cat = categoryByKey(server, e.category_key);
  const lines = e.line_items ?? [];
  const total = formatMinor(toMinor(e.amount) ?? 0n, e.currency);
  const time = clockOf(e.created_at);
  const caption = [`${dayLabel(e.spent_on, today, lang, t)}${time ? `, ${time}` : ''}`, sourceWord(e.source, t), t('exp.receipt_lines', { n: lines.length })]
    .filter(Boolean)
    .join(' · ');
  const tape = theme.colors.paper2;
  return (
    <View testID="exp-receipt">
      <View style={[styles.rowCenter, { alignItems: 'flex-end', gap: 8 }]}>
        <View style={styles.flex}>
          <BigNumber testID="exp-receipt-total" value={bareSum(total)} currency="₸" />
        </View>
        <Chip
          testID="exp-receipt-category"
          label={cat ? categoryTitle(cat, lang) : t('exp.no_category')}
          onPress={onCategory}
          icon={undefined}
          style={{ minHeight: 34 }}
        />
      </View>
      <AppText variant="footnote" style={{ marginTop: 6 }}>
        {caption}
      </AppText>
      <View style={{ marginTop: 14, backgroundColor: tape, borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingTop: 14, paddingHorizontal: 16, paddingBottom: 6 }}>
        <AppText style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 14.5, lineHeight: 19 }}>{e.payee ?? lineTitle(e, server, lang, t('exp.no_category'))}</AppText>
        <View style={{ marginTop: 8 }}>
          {lines.map((l, i) => (
            <View key={`${i}:${l.name}`} style={[styles.rowCenter, { paddingVertical: 5, gap: 8 }]}>
              <AppText style={[styles.flex, { fontSize: 14.5, lineHeight: 19 }]}>{l.qty ? `${l.name} × ${l.qty}` : l.name}</AppText>
              {l.total ? <AppText style={[styles.tabular, { fontSize: 14.5, lineHeight: 19 }]}>{bareSum(formatMinor(toMinor(l.total) ?? 0n, e.currency))}</AppText> : null}
            </View>
          ))}
          <View style={[styles.rowCenter, { paddingTop: 8, paddingBottom: 4, borderTopWidth: 1.5, borderStyle: 'dashed', borderTopColor: theme.colors.line2, gap: 8 }]}>
            <AppText style={[styles.flex, { fontFamily: theme.type.title.fontFamily, fontSize: 14.5 }]}>{t('exp.receipt_total')}</AppText>
            <AppText style={[styles.tabular, { fontFamily: theme.type.title.fontFamily, fontSize: 14.5 }]}>{bareSum(total)}</AppText>
          </View>
        </View>
      </View>
      {/* The torn edge of the tape. */}
      <Svg width="100%" height={10} preserveAspectRatio="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Defs>
          <Pattern id="zig" width={14} height={10} patternUnits="userSpaceOnUse">
            <Path d="M0 0 L7 10 L14 0 Z" fill={tape} />
          </Pattern>
        </Defs>
        <Rect x="0" y="0" width="100%" height="10" fill="url(#zig)" />
      </Svg>
    </View>
  );
}

type OverviewProps = {
  onPeriod: () => void;
  onSetBudget?: () => void;
  title: string;
  board: ReturnType<typeof board>;
  budget: bigint | null;
  today: string;
  period: Period;
  onlyToCheck: boolean;
  onToCheck: () => void;
};

function overviewNumbers(o: OverviewProps) {
  const main = o.board.main;
  const spent = main?.total ?? 0n;
  const currency = main?.currency ?? 'KZT';
  const left = o.budget !== null ? o.budget - spent : null;
  const share = o.budget !== null && o.budget > 0n ? Number((spent * 1000n) / o.budget) / 1000 : null;
  const daysLeft = o.period.to ? Math.max(0, Math.round((Date.parse(`${o.period.to}T12:00:00`) - Date.parse(`${o.today}T12:00:00`)) / 86_400_000)) : null;
  return { main, spent, currency, left, share, daysLeft };
}

/**
 * v5 «Расходы · месяц» sheet (screens-v5): «Ноябрь ▾» opens the period, the ONE big number of the screen, the short
 * phrase «Успеваете: ещё 65 650 ₸» (Geologica, the phrase size − 4; hidden at ≤ 340 dp / large font) and
 * «из 250 000 ₸ · до конца месяца 13 дней».
 */
function useOverviewSheet(o: OverviewProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const n = overviewNumbers(o);
  const ink = theme.colors.onSheet;
  const ink2 = theme.colors.onSheet2;
  const amount = formatMinor(n.spent, n.currency).replace(/\s?₸$/, '');
  const phrase =
    n.left === null ? null : n.left >= 0n ? t('exp.phrase_ok', { left: formatMinor(n.left) }) : t('exp.phrase_over', { over: formatMinor(-n.left) });
  const sub =
    o.budget !== null && n.left !== null
      ? [t('exp.sub_of', { budget: formatMinor(o.budget) }), n.daysLeft !== null ? t('exp.days_left', { count: n.daysLeft }) : null].filter(Boolean).join(' · ')
      : null;
  const phraseSize = theme.m.phraseSize - 4;
  const metaNode = (
    <Pressable
      testID="exp-period-open"
      accessibilityRole="button"
      accessibilityLabel={`${o.title}. ${t('exp.period_title')}`}
      onPress={o.onPeriod}
      hitSlop={8}
      style={({ pressed }) => [styles.rowCenter, { gap: 2, alignSelf: 'flex-start', minHeight: 40 }, pressedStyle(pressed)]}
    >
      <AppText testID="exp-status" variant="sheetMeta" style={{ color: ink2 }}>
        {o.title}
      </AppText>
      <ChevronDown size={18} color={ink2} strokeWidth={theme.icon.strokeWidth} />
    </Pressable>
  );
  const sheetExtra = (
    <View testID="exp-board">
      <View style={{ marginTop: 4 }} accessibilityLiveRegion="polite" accessible accessibilityLabel={t('exp.total_a11y', { period: o.title, amount: spokenAmount(minorToDecimal(n.spent), n.currency) })}>
        <BigNumber testID="exp-total" value={amount} currency={n.currency === 'KZT' ? '₸' : n.currency} color={ink} />
      </View>
      {phrase && !theme.m.titleOnly ? (
        <AppText
          testID="exp-phrase"
          numberOfLines={2}
          nativeID="v5-capped"
          maxFontSizeMultiplier={theme.m.heroMaxScale}
          style={[theme.type.phrase, { color: n.left !== null && n.left < 0n ? ink : ink, fontSize: phraseSize, lineHeight: Math.round(phraseSize * 1.12), letterSpacing: -0.025 * phraseSize, marginTop: 10 }]}
        >
          {phrase}
        </AppText>
      ) : null}
      {sub ? (
        <AppText testID="exp-budget-left" variant="sheetMeta" style={{ color: ink2, marginTop: 4, lineHeight: 20 }}>
          {theme.m.titleOnly && phrase ? `${phrase} · ${sub}` : sub}
        </AppText>
      ) : null}
    </View>
  );
  // QA v5-device-3 J1: the board's height from its tokens — 4 + the number (46 × 1.08) + the phrase (1 line) + sub.
  const fs = theme.m.fontScale;
  const height =
    4 +
    scaledLine(Math.round(46 * 1.08), fs, theme.m.heroMaxScale) +
    (phrase && !theme.m.titleOnly ? 10 + scaledLine(Math.round(phraseSize * 1.12), fs, theme.m.heroMaxScale) : 0) +
    (sub ? 4 + scaledLine(20, fs) : 0);
  const key = [o.title, amount, phrase, sub, theme.m.titleOnly, theme.scheme, phraseSize, fs].join('|');
  return { metaNode, sheetExtra, key, height };
}

/** Under the sheet: the count, «проверить N», «Задать бюджет», income and other currencies — small, on the paper. */
function OverviewPaper(o: OverviewProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const n = overviewNumbers(o);
  const main = n.main;
  return (
    <View style={{ gap: theme.space[1] }}>
      {!main || main.count === 0 ? (
        <AppText testID="exp-empty-total" variant="callout">
          {t('exp.empty_total')}
        </AppText>
      ) : (
        <View style={[styles.rowCenter, { flexWrap: 'wrap', columnGap: theme.space[2] }]}>
          <AppText testID="exp-count" variant="small">
            {t('exp.count', { count: Number(main.count) })}
          </AppText>
          {o.board.review > 0 || o.onlyToCheck ? (
            <Pressable
              testID="exp-to-check"
              accessibilityRole="button"
              accessibilityLabel={o.onlyToCheck ? t('exp.to_check_all') : t('exp.to_check_a11y', { n: o.board.review })}
              accessibilityState={{ selected: o.onlyToCheck }}
              onPress={o.onToCheck}
              style={{ minHeight: theme.size.minTouch, justifyContent: 'center' }}
            >
              <AppText variant="small" color="ink" style={{ fontFamily: theme.type.headline.fontFamily, textDecorationLine: 'underline' }}>
                {o.onlyToCheck ? t('exp.to_check_all') : t('exp.to_check', { n: o.board.review })}
              </AppText>
            </Pressable>
          ) : null}
        </View>
      )}
      {o.budget !== null && n.share !== null ? <Bar testID="exp-budget-bar" value={n.share} height={6} color={n.left !== null && n.left < 0n ? theme.colors.danger : theme.colors.ink} /> : null}
      {o.budget === null && o.onSetBudget ? (
        <Chip testID="exp-set-budget" label={t('budget.set')} onPress={o.onSetBudget} style={{ alignSelf: 'flex-start', marginTop: theme.space[1] }} />
      ) : null}
      {main && main.income > 0n ? (
        <AppText testID="exp-income" variant="small">
          {t('exp.income', { amount: formatMinor(main.income, main.currency) })}
        </AppText>
      ) : null}
      {o.board.apart.length > 0 ? (
        <AppText testID="exp-apart" variant="small">
          {t('exp.apart', { list: o.board.apart.map((x) => formatMinor(x.total, x.currency)).join(', ') })}
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
    <Sheet testID="exp-entry-sheet" title={t('exp.new_expense')} onClose={onClose}>
      <EntryPanel
        sum={sum}
        day={day}
        today={today}
        onDay={setDay}
        categories={chips}
        category={category?.key ?? null}
        onCategory={(c) => setCategory((prev) => (prev?.key === c.key ? null : c))}
        saveLabel={sum.minor !== null ? t('exp.save_sum', { amount: formatMinor(sum.minor) }) : t('exp.save')}
        look="v2"
        onSave={() => {
          if (sum.minor === null) return;
          void onSave({ minor: sum.minor, expression: storedExpression(sum.text), category, day });
        }}
      />
    </Sheet>
  );
}

/** Pattern 5: one row of the feed (≥56): the category circle, what + category, the amount; a tap opens it. */
function FeedLine({ e, today, first, marked, onOpen }: { e: ExpenseOut; today: string; first: boolean; marked: boolean; onOpen: () => void }) {
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
  const time = clockOf(e.created_at) || null;
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
          gap: 12,
          minHeight: theme.m.row,
          paddingVertical: theme.space[1],
          borderTopWidth: first ? 0 : 1,
          borderTopColor: theme.colors.line,
          backgroundColor: pressed ? theme.colors.paper2 : 'transparent',
        },
        // A new spending is ringed in terracotta for a moment (the assistant put it here).
        marked ? { borderRadius: 12, borderWidth: 2, borderColor: theme.colors.place.assistant, paddingHorizontal: 6 } : null,
      ]}
    >
      <CategorySquare color={categoryLook(theme, e.category_key).color} />
      <View style={[styles.flex, { minWidth: theme.largeFont ? '60%' : undefined }]}>
        <AppText numberOfLines={2}>{title}</AppText>
        {meta && meta !== catTitle ? <AppText variant="footnote">{meta}</AppText> : null}
        <ChangedMark at={e.assistant_changed_at} actionId={e.assistant_action_id} testID={`changed-exp-${e.id}`} />
      </View>
      {time && !theme.largeFont ? <RowMeta>{time}</RowMeta> : null}
      <View style={{ alignItems: 'flex-end', minWidth: 70 }}>
        <AppText
          testID={`exp-row-amount-${e.id}`}
          variant="number"
          style={toCheck ? { backgroundColor: theme.colors.marker, paddingHorizontal: theme.space[1], borderRadius: 4 } : undefined}
        >
          {bareSum(formatMinor(signed, e.currency))}
        </AppText>
        {toCheck ? <AppText variant="footnote">{t('exp.check')}</AppText> : null}
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
  onOpenReceipt,
  onClose,
}: {
  e: ExpenseOut;
  today: string;
  chips: Category[];
  hasRecord: boolean;
  startEditing?: boolean;
  onOpenRecord: () => void;
  /** A receipt with lines: «Открыть чек» (screens-v5 «Расходы · чек»). */
  onOpenReceipt?: () => void;
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
          ...(onOpenReceipt ? [{ key: 'receipt', testID: 'exp-sheet-receipt', label: t('exp.open_receipt'), onPress: onOpenReceipt }] : []),
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

/** «18 400 ₸» → «18 400»: in rows the sign is implied (screens-v5 «Расходы»). */
const bareSum = (money: string) => money.replace(/\s?₸$/, '');

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  start: { alignSelf: 'flex-start' },
  tabular: { fontVariant: ['tabular-nums'] },
});
