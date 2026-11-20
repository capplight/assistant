import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ellipsis, Search, SlidersHorizontal } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Pressable, ScrollView, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { useMinuteClock } from '@/components/ReminderLists';
import type { CalEntry } from '@/calendar/entries';
import { centerScroll, GRID, gridAsRows, initialScroll, multiDayColumns } from '@/calendar/geometry';
import { backStep, pageStep, switchView, type CalView } from '@/calendar/nav';
import { addTimed, deleteEntry, followsFocus, moveEntry, refreshRange, setEntryDone } from '@/calendar/service';
import { calState, useCalendar } from '@/calendar/store';
import { addDaysIso, addMonths, hhmm, isoDate, monthGrid, weekDays } from '@/calendar/time';
import { useCalendarEntries } from '@/calendar/useEntries';
import { useChrome } from '@/store/chrome';
import type { Page } from '@/store/pages';
import { expandedSheetHeight, PlaceScreen } from '@/components/ui/PlaceScreen';
import { ActionList, Sheet, type SheetAction } from '@/components/ui';
import { WeekStrip, weekStripHeight } from '@/components/today/EmptyToday';
import { onPlace, useTheme } from '@/theme';

import { AppText } from '../AppText';
import { CheckMark } from '../ui/Check';
import { DayGrid, type DropTo, type GridDraft } from './DayGrid';
import { EntryRows, MonthView } from './MonthView';
import { CalSheetTop, monthTitle, VIEW_SWITCH_HEIGHT, ViewSwitch } from './parts';
import { EntryCard } from './EntryCard';
import { AddSheet, HourSheet, ScopeSheet } from './Sheets';

/**
 * Ф-89 / Ф-90 / Ф-91 — «Дела» as a calendar, direction A «Лист дня» (calendar-time.html A0–A5). The lilac sheet does
 * not collapse; its height is known from tokens before the first frame: the top row 40 («‹» · month · «⋯»), the views
 * 42, the week (or the month strip) 64. The paper: «весь день» 44 (or the column heads) and the hour grid. No «+» (Ф-91:
 * add by a tap on empty time or by the assistant line), no «К сегодня»; the ONE back steps: another day → the calendar on
 * today → where it came from (`calendar/nav.ts`).
 */
export function CalendarScreen({ page }: { page: Page }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const m = theme.m;
  const c = theme.colors;
  const now = useMinuteClock();
  const today = isoDate(now);
  const { view, date: stored, focus } = useCalendar(useShallow((s) => ({ view: s.view, date: s.date, focus: s.focus })));
  const date = stored ?? today;
  const { from } = useLocalSearchParams<{ from?: string }>();
  const cols = multiDayColumns(m.width);
  const rows = gridAsRows(m);
  const nav = { view, date };
  const setNav = (n: { view: CalView; date: string }) => calState().set({ view: n.view, date: n.date === today ? null : n.date });

  // The range on screen (and fetched): a day, 3 / 7 days from the chosen one, the 6-week month.
  const dates = view === 'multi' ? Array.from({ length: cols }, (_, i) => addDaysIso(date, i)) : [date];
  const grid = monthGrid(date);
  const rangeFrom = view === 'month' ? grid[0]! : view === 'multi' ? dates[0]! : weekDays(date)[0]!;
  const rangeTo = view === 'month' ? grid[41]! : view === 'multi' ? dates[dates.length - 1]! : weekDays(date)[6]!;
  const entries = useCalendarEntries(rangeFrom, rangeTo);
  useEffect(() => {
    const id = setTimeout(() => void refreshRange(rangeFrom, rangeTo), 300);
    return () => clearTimeout(id);
  }, [rangeFrom, rangeTo]);

  // --- the ONE back (the arrow and the system back do the same) ---
  const leave = useCallback(() => {
    calState().set({ date: null });
    if (from === 'more') router.navigate('/more');
    else router.navigate('/');
  }, [from]);
  const [scrollTo, setScrollTo] = useState<{ y: number; seq: number } | null>(null);
  const seq = useRef(0);
  const viewport = useMemo(() => {
    const sheetH = expandedSheetHeight({ m, meta: true, extra: VIEW_SWITCH_HEIGHT + weekStripHeight(m) });
    const tabBar = useChrome.getState().tabBarHeight || m.tab.barHeight;
    return Math.max(240, m.height - m.top - sheetH + 28 - GRID.allDayTop - GRID.allDay - tabBar);
  }, [m]);
  const back = useCallback(() => {
    const step = backStep({ view, date }, today);
    if (step.kind === 'leave') return leave();
    setNav(step.nav);
    setScrollTo({ y: initialScroll({ viewport, now: minutesNow(now), first: null }), seq: ++seq.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setNav reads today
  }, [view, date, today, leave, viewport, now]);
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        back();
        return true;
      });
      return () => sub.remove();
    }, [back]),
  );
  // Leaving the calendar: the next open is today again (the view stays: §2 «экран запоминает последний вид»).
  useFocusEffect(useCallback(() => () => calState().set({ date: null }), []));

  // «Добавить на пятницу…» in the assistant strip for another day, «Добавить дело…» for today (§5).
  const wd = new Date(`${date}T12:00:00`).getDay();
  const hint = date === today ? t('cal.ask_today') : t(`today.dv_ask_${wd}`);
  useEffect(() => {
    useChrome.getState().setAskHint(hint);
    return () => useChrome.getState().setAskHint(null);
  }, [hint]);

  // --- the assistant made / moved a timed to-do (§5): go to its day (unless browsing another), ring 1.5 s ---
  const [ring, setRing] = useState<string | null>(null);
  const seenFocus = useRef(focus?.seq ?? 0);
  useEffect(() => {
    if (!focus || focus.seq === seenFocus.current) return;
    seenFocus.current = focus.seq;
    if (!followsFocus(date, focus, today)) return;
    if (view !== 'list' && view !== 'month' && focus.date !== date) setNav({ view, date: focus.date });
    if (focus.startMin !== null) setScrollTo({ y: centerScroll({ viewport, start: focus.startMin, duration: 60 }), seq: ++seq.current });
    setRing(`task:${focus.taskId}:`);
    const id = setTimeout(() => setRing(null), Math.max(0, focus.until - Date.now()));
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to a new focus only
  }, [focus?.seq]);

  // --- sheets ---
  const [draft, setDraft] = useState<GridDraft | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [scope, setScope] = useState<{ kind: 'move' | 'delete'; entry: CalEntry; to?: DropTo } | null>(null);
  const [hour, setHour] = useState<string[] | null>(null);
  const [menu, setMenu] = useState(false);
  const [emptySeen, setEmptySeen] = useState<string | null>(null);
  const opened = openKey ? entries.find((e) => e.key === openKey) ?? null : null;

  const open = (e: CalEntry) => {
    setHour(null);
    if (e.kind === 'reminder') return router.push({ pathname: '/reminder-new', params: { text: e.title, editId: e.id } });
    if (e.kind === 'plan_step' && e.plan) return router.push({ pathname: '/plan/[id]', params: { id: e.plan.id } });
    setOpenKey(e.key);
  };
  const toggle = (e: CalEntry) => void setEntryDone(e, !e.done);
  const drop = (e: CalEntry, to: DropTo) => {
    if (e.occurrenceAt) return setScope({ kind: 'move', entry: e, to });
    void moveEntry(e, to);
  };
  const swipe = (dir: -1 | 1) => setNav(pageStep(nav, dir, cols));

  const firstTimed = entries.filter((e) => e.date === date && e.start !== null).map((e) => e.start!)[0] ?? null;
  const initialY = useMemo(
    () => initialScroll({ viewport, now: date === today ? minutesNow(now) : null, first: firstTimed }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- where the grid opens, once per day shown
    [date, view],
  );

  // --- the sheet: «‹» · month · «⋯», the views, the week / month strip ---
  const back_a11y = date !== today ? t('cal.back_today_a11y') : t('cal.back_a11y', { place: from === 'more' ? t('more.title') : t('today.today') });
  const weekDates = weekDays(view === 'multi' ? date : date);
  const countOf = (d: string) => entries.filter((e) => e.date === d).length;
  const week = weekDates.map((d) => ({
    date: d,
    label: weekdayShort(i18n.language, d),
    num: String(Number(d.slice(8))),
    name: weekdayLong(i18n.language, d),
    count: countOf(d),
    past: d < today,
    today: d === today,
    selected: d === date,
  }));
  const strip =
    view === 'month' ? (
      <MonthStrip date={date} today={today} lang={i18n.language} onMonth={(d) => setNav({ view, date: d })} />
    ) : (
      <WeekStrip
        testID="cal-week"
        place="tasks"
        days={week}
        range={view === 'multi' ? { from: dates[0]!, to: dates[dates.length - 1]! } : null}
        onDay={(d) => setNav({ view, date: d })}
        onWeek={(s) => setNav({ view, date: addDaysIso(date, 7 * s) })}
      />
    );
  const sheetExtra = (
    <View>
      <ViewSwitch value={view} week={cols === 7} onChange={(v) => setNav(switchView(nav, v))} />
      {strip}
    </View>
  );
  const menuActions: SheetAction[] = [
    { key: 'find', testID: 'cal-find', label: t('page.find'), icon: Search, onPress: () => (setMenu(false), router.navigate({ pathname: '/search', params: { page: page.id } })) },
    { key: 'settings', testID: 'cal-settings', label: t('view.settings'), icon: SlidersHorizontal, onPress: () => (setMenu(false), router.push({ pathname: '/page-settings/[id]', params: { id: page.id } })) },
  ];

  const allDay = entries.filter((e) => e.date === date && e.allDay);
  const dayEntries = entries.filter((e) => dates.includes(e.date));
  const emptyDay = view === 'day' && dayEntries.length === 0 && emptySeen !== date;

  let body;
  if (view === 'month') {
    body = (
      <MonthView
        date={date}
        now={now}
        entries={entries}
        onPick={(d) => setNav({ view, date: d })}
        onOpenDay={(d) => setNav({ view: 'day', date: d })}
        onOpen={open}
        onToggle={toggle}
      />
    );
  } else if (rows) {
    // §6: large font ≥ 1.3 and ≤ 340 dp — «время — дело» rows; moving goes through the card.
    body = (
      <ScrollView testID="cal-rows" contentContainerStyle={{ paddingHorizontal: m.gutter, paddingTop: 12, paddingBottom: GRID.bottomRoom + 24 }}>
        {dates.map((d) => (
          <View key={d}>
            {dates.length > 1 ? <AppText style={[theme.type.section, { marginTop: 12, color: c.ink }]}>{weekdayLong(i18n.language, d)}</AppText> : null}
            <EntryRows large={m.largeText} entries={entries.filter((e) => e.date === d)} onOpen={open} onToggle={toggle} />
          </View>
        ))}
      </ScrollView>
    );
  } else {
    body = (
      <View style={{ flex: 1 }}>
        {view === 'multi' ? (
          <ColumnHeads dates={dates} today={today} counts={dates.map((d) => entries.filter((e) => e.date === d && e.allDay).length)} />
        ) : (
          <AllDayStrip entries={allDay} onOpen={open} onToggle={toggle} />
        )}
        <DayGrid
          dates={dates}
          entries={dayEntries}
          now={now}
          width={m.width}
          viewport={viewport}
          initialY={initialY}
          scrollTo={scrollTo}
          ringKey={ring}
          draft={draft}
          dragEnabled
          onEmpty={(d) => setDraft(d)}
          onOpen={open}
          onToggle={toggle}
          onDrop={drop}
          onMore={(keys) => setHour(keys)}
          onSwipe={swipe}
          onTouch={() => setEmptySeen(date)}
        />
        {emptyDay ? (
          <View
            testID="cal-empty-day"
            pointerEvents="none"
            style={{ position: 'absolute', left: 68, right: m.gutter, top: 96, zIndex: 3, backgroundColor: c.paper, borderRadius: 18, borderWidth: 1, borderColor: c.line, paddingVertical: 14, paddingHorizontal: 16 }}
          >
            <AppText style={{ fontFamily: theme.type.title.fontFamily, fontSize: 17, lineHeight: 21, color: c.ink }}>{t(`today.dv_title_${wd}`)}</AppText>
            <AppText style={{ fontSize: 15, lineHeight: 21, color: c.ink2, marginTop: 6 }}>{t(`today.dv_text_${wd}`)}</AppText>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <PlaceScreen
      testID="page-tasks"
      headerTestID="page-header"
      place="tasks"
      title={t('cal.view_day')}
      hideTitle
      scroll={false}
      askRoom
      paperPadding={0}
      contentContainerStyle={{ paddingTop: 0, paddingBottom: 0 }}
      metaNode={<CalSheetTop month={monthTitle(i18n.language, date, today)} onBack={back} backLabel={back_a11y} />}
      actions={[{ key: 'menu', testID: 'page-menu', icon: Ellipsis, label: t('cal.menu_a11y'), onPress: () => setMenu(true) }]}
      sheetExtra={sheetExtra}
      sheetExtraHeight={VIEW_SWITCH_HEIGHT + weekStripHeight(m)}
    >
      <View testID="cal-screen" style={{ flex: 1 }}>
        {body}
      </View>
      {draft ? (
        <AddSheet
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onAdd={(a) => {
            setDraft(null);
            void addTimed(a);
          }}
        />
      ) : null}
      {opened ? <EntryCard entry={opened} onClose={() => setOpenKey(null)} /> : null}
      {scope ? (
        <ScopeSheet
          kind={scope.kind}
          onClose={() => setScope(null)}
          onPick={(s) => {
            const x = scope;
            setScope(null);
            if (x.kind === 'delete') void deleteEntry(x.entry, s);
            else if (x.to) void moveEntry(x.entry, x.to, s);
          }}
        />
      ) : null}
      {hour ? (
        <HourSheet
          title={hhmm(entries.find((e) => e.key === hour[0])?.start ?? 0)}
          entries={entries.filter((e) => hour.includes(e.key))}
          onOpen={open}
          onToggle={toggle}
          onClose={() => setHour(null)}
        />
      ) : null}
      {menu ? (
        <Sheet testID="page-menu-sheet" visible onClose={() => setMenu(false)} title={t('cal.view_day')}>
          <ActionList actions={menuActions} />
        </Sheet>
      ) : null}
    </PlaceScreen>
  );
}

const minutesNow = (ms: number) => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
};

function weekdayShort(lang: string, d: string): string {
  try {
    return new Date(`${d}T12:00:00`).toLocaleDateString(lang, { weekday: 'short' }).replace(/\.$/u, '');
  } catch {
    return d;
  }
}
function weekdayLong(lang: string, d: string): string {
  try {
    return new Date(`${d}T12:00:00`).toLocaleDateString(lang, { weekday: 'long' });
  } catch {
    return d;
  }
}

/** «весь / день» 44 (`.allday`): capsules 32 (≤ 62 % each), then «+N»; empty — «ничего», the height never changes. */
function AllDayStrip({ entries, onOpen, onToggle }: { entries: CalEntry[]; onOpen: (e: CalEntry) => void; onToggle: (e: CalEntry) => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const c = theme.colors;
  const first = entries[0];
  return (
    <View testID="cal-allday" style={{ height: GRID.allDay, marginTop: GRID.allDayTop, flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: theme.m.gutter, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <AppText maxFontSizeMultiplier={1} style={{ width: GRID.timeColumn, paddingLeft: theme.m.gutter, fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 13, lineHeight: 15, color: c.ink3 }}>
        {t('cal.all_day')}
      </AppText>
      {first ? (
        <View
          testID={`cal-allday-${first.key}`}
          style={{ height: 32, borderRadius: 16, backgroundColor: c.paper2, paddingLeft: 6, paddingRight: 12, flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '62%', flexShrink: 1 }}
        >
          <Pressable testID={`cal-allday-check-${first.key}`} accessibilityRole="checkbox" accessibilityState={{ checked: first.done }} accessibilityLabel={first.title} onPress={() => onToggle(first)} hitSlop={12} style={{ transform: [{ scale: 20 / 26 }], margin: -3 }}>
            <CheckMark checked={first.done} waiting={first.pending} />
          </Pressable>
          <AppText numberOfLines={1} onPress={() => onOpen(first)} style={{ flexShrink: 1, fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 14, lineHeight: 16, color: first.done ? c.ink3 : c.ink, textDecorationLine: first.done ? 'line-through' : 'none' }}>
            {first.title}
          </AppText>
        </View>
      ) : (
        <AppText style={{ fontSize: 14, lineHeight: 16, color: c.ink3 }}>{t('cal.nothing')}</AppText>
      )}
      {entries.length > 1 ? (
        <View testID="cal-allday-more" style={{ height: 32, borderRadius: 16, backgroundColor: c.paper2, paddingHorizontal: 12, justifyContent: 'center' }}>
          <AppText onPress={() => onOpen(entries[1]!)} style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 14, lineHeight: 16, color: c.ink2 }}>{`+${entries.length - 1}`}</AppText>
        </View>
      ) : null}
    </View>
  );
}

/** «3 дня» column heads 30: only the number (the weekday is in the week), today in a black capsule, + the all-day count. */
function ColumnHeads({ dates, today, counts }: { dates: string[]; today: string; counts: number[] }) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <View testID="cal-colheads" style={{ height: GRID.colHead, marginTop: GRID.colHeadTop, flexDirection: 'row', paddingLeft: GRID.timeColumn, borderBottomWidth: 1, borderBottomColor: c.line }}>
      {dates.map((d, i) => (
        <View key={d} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, borderLeftWidth: 1, borderLeftColor: c.line }}>
          <View style={d === today ? { backgroundColor: c.ink, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 3 } : null}>
            <AppText maxFontSizeMultiplier={1.2} style={{ fontFamily: theme.type.title.fontFamily, fontSize: 15, lineHeight: 17, color: d === today ? c.paper : c.ink, fontVariant: ['tabular-nums'] }}>
              {String(Number(d.slice(8)))}
            </AppText>
          </View>
          {counts[i] ? <AppText style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 13, lineHeight: 15, color: c.ink2 }}>{`· ${counts[i]}`}</AppText> : null}
        </View>
      ))}
    </View>
  );
}

/**
 * «Месяц»: the strip of months in place of the week, the same component height (64), so the sheet never changes height
 * with the view («сен окт ноя дек янв…», the year over January).
 */
function MonthStrip({ date, today, lang, onMonth }: { date: string; today: string; lang: string; onMonth: (d: string) => void }) {
  const theme = useTheme();
  const c = onPlace(theme.colors, 'tasks');
  const bg = theme.colors.place.tasks;
  const small = theme.m.size === 'small';
  const months = Array.from({ length: 7 }, (_, i) => addMonths(date, i - 2));
  const h = weekStripHeight(theme.m) - (small ? 10 : 14);
  return (
    <View testID="cal-months" style={{ flexDirection: 'row', gap: 2, marginTop: small ? 10 : 14, marginHorizontal: small ? -4 : -6, height: h }}>
      {months.map((mo) => {
        const on = mo.slice(0, 7) === date.slice(0, 7);
        const past = mo.slice(0, 7) < today.slice(0, 7);
        let name = mo.slice(5, 7);
        try {
          name = new Date(`${mo.slice(0, 7)}-15T12:00:00`).toLocaleDateString(lang, { month: 'short' }).replace(/\.$/u, '');
        } catch {
          // the number stays
        }
        const year = mo.slice(5, 7) === '01' || (mo === months[0] && mo.slice(0, 4) !== today.slice(0, 4)) ? mo.slice(0, 4) : '';
        return (
          <Pressable
            key={mo}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${name} ${mo.slice(0, 4)}`}
            onPress={() => onMonth(on ? date : `${mo.slice(0, 7)}-01`)}
            testID={`cal-month-${mo.slice(0, 7)}`}
            style={{ flex: 1, minWidth: 0, alignItems: 'center', gap: 4, paddingVertical: 7, borderRadius: 18, backgroundColor: on ? c.ink : 'transparent' }}
          >
            <AppText numberOfLines={1} maxFontSizeMultiplier={1.5} style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 13, lineHeight: 15, color: on ? bg : c.ink2 }}>
              {year || ' '}
            </AppText>
            <AppText numberOfLines={1} maxFontSizeMultiplier={1.5} style={{ fontFamily: past && !on ? theme.type.sheetMeta.fontFamily : theme.type.stripTitle.fontFamily, fontSize: small ? 16 : 17, lineHeight: small ? 19 : 20, color: on ? bg : past ? c.ink2 : c.ink }}>
              {name}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
