import { useKeepAwake } from 'expo-keep-awake';
import { Minus, Plus, ShoppingCart } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { TaskOut } from '@/api/types';
import type { LocalRecord } from '@/db';
import { changeTask, clearBought, qtyCount, qtyText, shownTask } from '@/tasks/edit';
import { changeView } from '@/pages/viewService';
import { useView } from '@/store/view';
import '@/tasks/actions'; // the undo of a tick (registers `tickUndo`)
import { listRows, localDate, type ListRow } from '@/tasks/rows';
import { listsForPage, setDone } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import type { MenuExtra } from '../RecordMenuSheet';
import { useMinuteClock } from '../ReminderLists';
import { TaskRow } from '../TaskRow';
import { BackButton, Button, Card, Icon, Sheet } from '../ui';
import { EntryList, type EntryCtx } from './EntryList';
import { PageEmpty } from './PageEmpty';
import { fromList, type EntryRow, type Row } from './rows';
import type { ViewProps } from './registry';

/** «Ещё в магазине?» after this long without a touch in the mode (template-screens 5). */
export const SHOP_IDLE_MS = 30 * 60_000;

const taskOf = (r: ListRow): TaskOut | null => r.task;

/** Group names compare ignoring case, «ё»/«е» and extra spaces (views.md «Group order»). */
export const groupKey = (s: string) => s.trim().split(' ').filter(Boolean).join(' ').toLowerCase().replace(/ё/g, 'е');

/**
 * Open rows by «Где купить» when the page is grouped by it (`group_by: "where"`, today.md): the
 * names of `group_order` first in that order, the other groups as their first row appears, rows
 * without a place («Без места») last. Not grouped: one group, the page order. Pure, so the list
 * and «Я в магазине» group the same way.
 */
export function byPlace(
  open: ListRow[],
  o: { grouped: boolean; order?: string[] } = { grouped: true },
): { where: string | null; rows: ListRow[] }[] {
  if (!o.grouped) return open.length > 0 ? [{ where: null, rows: open }] : [];
  const found: { where: string | null; rows: ListRow[] }[] = [];
  for (const r of open) {
    const raw = taskOf(r)?.where?.trim() || null;
    const g = found.find((x) => (x.where === null ? raw === null : raw !== null && groupKey(x.where) === groupKey(raw)));
    if (g) g.rows.push(r);
    else found.push({ where: raw, rows: [r] });
  }
  const rank = new Map((o.order ?? []).map((n, i) => [groupKey(n), i] as const));
  const at = (g: { where: string | null }) => (g.where === null ? Infinity : (rank.get(groupKey(g.where)) ?? rank.size));
  // A stable sort: named ones by the order, the rest as they appear, «Без места» last.
  return found
    .map((g, i) => ({ g, i }))
    .sort((a, b) => at(a.g) - at(b.g) || a.i - b.i)
    .map((x) => x.g);
}

/**
 * «Покупки» — the list on the fridge (notes-tasks-shopping rule 7; template-screens 2.4). «Осталось 5 из 8» with a
 * bar, rows by «Где купить». A tap anywhere on the row = bought (Bring!); the circle is 24; the amount is text on
 * the right («2 шт», 15 ink2) and a tap on it opens the sheet with «− 2 +» — no steppers on the rows. Long press:
 * the shared menu. «Куплено (3)» goes below, grey, with «Вернуть» and «Убрать все» (one «Отменить»), and
 * [Я в магазине]. Ticks at once, offline and in «Без ИИ» (week 9 outbox, «Отменить»).
 */
export function ShoppingView({ page, entries, frameTop, ordering }: ViewProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const lists = useMemo(() => listsForPage(page), [page]);
  const tasksMap = useTasks((st) => st.tasks);
  const ticks = useTasks((st) => st.ticks);
  const edits = useTasks((st) => st.edits);
  const shop = useView((st) => st.shopMode === page.id);
  const setShopMode = useView((st) => st.setShopMode);
  const today = localDate(useMinuteClock());
  const [qtyFor, setQtyFor] = useState<string | null>(null);

  // Leaving the page leaves the mode (tabs and the full line come back).
  useEffect(() => () => setShopMode(null), [page.id, setShopMode]);

  const tasks = useMemo(() => Object.values(tasksMap).map((x) => shownTask(x, edits)), [tasksMap, edits]);
  const lr = useMemo(() => listRows(entries ?? [], tasks, ticks, { lists, today }), [entries, tasks, ticks, lists, today]);
  const grouped = page.view?.groupBy === 'where';
  const order = page.view?.groupOrder;
  const groups = useMemo(() => byPlace(lr.open, { grouped, order }), [lr.open, grouped, order]);
  const named = groups.filter((g) => g.where !== null).map((g) => g.where!);
  const total = lr.open.length + lr.done.length;
  const taskByItem = useMemo(() => new Map(tasks.filter((x) => x.item_id).map((x) => [x.item_id!, x])), [tasks]);
  const qtyTask = qtyFor ? (tasks.find((x) => x.id === qtyFor) ?? null) : null;

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const g of groups) {
      if (grouped) out.push(g.where !== null ? { type: 'group', key: `where:${g.where}`, title: g.where } : { type: 'group', key: 'nowhere', title: '' });
      out.push(...g.rows.map(fromList));
    }
    if (lr.done.length > 0) {
      out.push({ type: 'group', key: 'done', title: String(lr.done.length) });
      out.push(...lr.done.map(fromList));
    }
    return out;
  }, [groups, lr.done, grouped]);

  if (shop) return <ShopMode open={groups} left={lr.open.length} onExit={() => setShopMode(null)} />;

  const bought = lr.done.map(taskOf).filter((x): x is TaskOut => !!x);

  const menuExtra = (record: LocalRecord): MenuExtra[] => {
    const task = record.serverId ? taskByItem.get(record.serverId) : undefined;
    const n = task ? qtyCount(task.qty) : null;
    if (!task || n === null) return [];
    return [
      {
        testID: 'menu-qty-plus',
        label: t('shop.qty_more'),
        hint: t('shop.qty_now', { n }),
        onPress: () => void changeTask(task.id, { qty: qtyText(n + 1) }, t('shop.qty_set', { title: task.title, n: n + 1 })),
      },
    ];
  };

  const progress = total > 0 ? (total - lr.open.length) / total : 0;
  const header = (
    <View style={{ marginBottom: theme.space[2], gap: theme.space[3] }}>
      {frameTop}
      {total > 0 ? (
        <View style={{ gap: theme.space[2] }}>
          <View style={[styles.row, { gap: theme.space[2], flexWrap: 'wrap' }]}>
            <AppText testID="shop-left" variant="headline" accessibilityLiveRegion="polite" style={styles.flex}>
              {t('shop.left', { left: lr.open.length, total })}
            </AppText>
            {lr.open.length > 0 ? (
              <Button
                testID="shop-mode"
                label={t('shop.in_store')}
                variant="secondary"
                size="small"
                icon={<Icon icon={ShoppingCart} size="sm" color="brand" />}
                onPress={() => setShopMode(page.id)}
              />
            ) : null}
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: total, now: total - lr.open.length }}
            style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surfaceSunken, overflow: 'hidden' }}
          >
            <View style={{ width: `${Math.round(progress * 100)}%`, height: 6, borderRadius: 3, backgroundColor: theme.colors.brand }} />
          </View>
        </View>
      ) : null}
    </View>
  );

  const renderEntry = (row: EntryRow, ctx: EntryCtx) => {
    const task = row.task;
    if (!task) return null;
    const counted = qtyCount(task.qty) !== null && !!task.qty;
    return (
      <View onLayout={ctx.onLayout}>
        <TaskRow
          task={task}
          done={row.done}
          showReturn
          highlighted={ctx.highlighted}
          qtyLabel={task.qty}
          onQty={counted ? () => setQtyFor(task.id) : undefined}
          onToggle={() => void setDone(task.id, !row.done)}
          onMenu={ctx.moves?.onMenu}
        />
      </View>
    );
  };

  const groupTitle = (g: Extract<Row, { type: 'group' }>) =>
    g.key === 'done' ? t('shop.bought_n', { n: Number(g.title) || 0 }) : g.key === 'nowhere' ? t('shop.no_place') : g.title;

  // «Порядок»: the shops move with ↑ ↓ — the whole order goes as `group_order` (views.md).
  const moveGroup = (name: string, step: -1 | 1) => {
    const i = named.indexOf(name);
    const j = i + step;
    if (i < 0 || j < 0 || j >= named.length) return;
    const next = [...named];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void changeView(page, { kind: 'group_order', order: next, moved: name });
  };
  const renderGroup = (g: Extract<Row, { type: 'group' }>) => {
    if (!ordering || !g.key.startsWith('where:')) return null;
    const name = g.title;
    const i = named.indexOf(name);
    return (
      <View style={[styles.row, { paddingTop: theme.space[3], gap: theme.space[1] }]}>
        <AppText testID={`group-${g.key}`} variant="sectionLabel" accessibilityRole="header" style={styles.flex}>
          {name}
        </AppText>
        <Button
          testID={`group-up-${name}`}
          label="↑"
          accessibilityLabel={t('shop.group_up_a11y', { name })}
          variant="secondary"
          size="small"
          disabled={i <= 0}
          onPress={() => moveGroup(name, -1)}
        />
        <Button
          testID={`group-down-${name}`}
          label="↓"
          accessibilityLabel={t('shop.group_down_a11y', { name })}
          variant="secondary"
          size="small"
          disabled={i >= named.length - 1}
          onPress={() => moveGroup(name, 1)}
        />
      </View>
    );
  };

  const footer =
    bought.length > 0 ? (
      <Button
        testID="shop-clear-bought"
        label={t('shop.clear_bought')}
        variant="text"
        onPress={() => void clearBought(bought.map((x) => x.id), t('shop.cleared', { count: bought.length }))}
      />
    ) : undefined;

  return (
    <>
      <EntryList
        page={page}
        rows={rows}
        header={header}
        footer={footer}
        ordering={ordering}
        renderEntry={renderEntry}
        menuExtra={menuExtra}
        groupTitle={groupTitle}
        renderGroup={renderGroup}
        empty={entries ? <PageEmpty icon={ShoppingCart} lines={[t('shop.empty')]} /> : null}
      />
      {qtyTask ? <QtySheet task={qtyTask} onClose={() => setQtyFor(null)} /> : null}
    </>
  );
}

/** «Сколько»: the one place with «− 2 +» (a plain count; «1 кг» stays as written and has no sheet). */
function QtySheet({ task, onClose }: { task: TaskOut; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const n = qtyCount(task.qty) ?? 1;
  const set = (m: number) => void changeTask(task.id, { qty: qtyText(m) }, t('shop.qty_set', { title: task.title, n: m }));
  const d = theme.size.buttonHeight;
  const btn = (testID: string, label: string, disabled: boolean, onPress: () => void, icon: typeof Plus) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.round,
        { width: d, height: d, borderRadius: d / 2, backgroundColor: theme.colors.brandTint, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      <Icon icon={icon} color="brand" />
    </Pressable>
  );
  return (
    <Sheet visible testID="qty-sheet" title={t('shop.qty_title', { title: task.title })} onClose={onClose}>
      <View style={[styles.row, { justifyContent: 'center', gap: theme.space[6], paddingVertical: theme.space[3] }]}>
        {btn(`qty-minus-${task.id}`, t('shop.qty_less_a11y', { title: task.title }), n <= 1, () => set(n - 1), Minus)}
        <AppText
          testID={`qty-value-${task.id}`}
          variant="amount"
          accessibilityLabel={t('shop.qty_a11y', { n })}
          accessibilityLiveRegion="polite"
          style={{ minWidth: 56, textAlign: 'center' }}
        >
          {String(n)}
        </AppText>
        {btn(`qty-plus-${task.id}`, t('shop.qty_more_a11y', { title: task.title }), n >= 999, () => set(n + 1), Plus)}
      </View>
    </Sheet>
  );
}

/**
 * «Я в магазине» (notes-tasks-shopping rule 7): no frame, no tabs; big high-contrast rows (64, `title2` semibold
 * `ink`), the whole row is the tick; groups by shop; the screen stays on (expo-keep-awake); after 30 minutes
 * without a touch «Ещё в магазине?» comes up at the bottom. No network needed.
 */
function ShopMode({ open, left, onExit }: { open: { where: string | null; rows: ListRow[] }[]; left: number; onExit: () => void }) {
  useKeepAwake('shop-mode');
  const theme = useTheme();
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touched = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAsking(true), SHOP_IDLE_MS);
  };
  useEffect(() => {
    touched();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <View testID="shop-mode-screen" style={styles.flexCol} onTouchStart={touched}>
      <View style={{ paddingTop: theme.space[2], gap: theme.space[1] }}>
        <BackButton testID="shop-exit" label={t('shop.exit')} onPress={onExit} />
        <AppText testID="shop-mode-left" variant="largeTitle" accessibilityRole="header" accessibilityLiveRegion="polite">
          {t('shop.left_short', { left })}
        </AppText>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: theme.space[6] }}>
        {left === 0 ? (
          <AppText testID="shop-all-done" variant="title1" style={{ paddingTop: theme.space[6] }}>
            {t('shop.all_done')}
          </AppText>
        ) : null}
        {open.map((g) => (
          <View key={g.where ?? '-'} style={{ marginTop: theme.space[3] }}>
            {g.where ? (
              <AppText variant="headline" accessibilityRole="header" style={{ paddingBottom: theme.space[1] }}>
                {g.where}
              </AppText>
            ) : null}
            <Card padded={false} style={{ paddingHorizontal: theme.space[2] }}>
              {g.rows.map((r, i) =>
                r.task ? (
                  <TaskRow
                    key={r.task.id}
                    task={r.task}
                    done={r.done}
                    big
                    separator={i < g.rows.length - 1}
                    onToggle={() => void setDone(r.task!.id, !r.done)}
                  />
                ) : null,
              )}
            </Card>
          </View>
        ))}
      </ScrollView>
      {asking ? (
        <Card testID="shop-still" tone="raised" style={[{ gap: theme.space[3], marginBottom: theme.space[3] }, theme.elevation.floating]}>
          <AppText variant="headline" accessibilityLiveRegion="polite">
            {t('shop.still_q')}
          </AppText>
          <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[2] }}>
            <Button
              testID="shop-still-yes"
              label={t('shop.still_yes')}
              style={theme.largeFont ? undefined : styles.flex}
              onPress={() => {
                setAsking(false);
                touched();
              }}
            />
            <Button testID="shop-still-exit" label={t('shop.exit')} variant="secondary" style={theme.largeFont ? undefined : styles.flex} onPress={onExit} />
          </View>
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  flexCol: { flex: 1 },
  round: { alignItems: 'center', justifyContent: 'center' },
});
