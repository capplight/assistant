import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { render } from '@testing-library/react-native';
import { BackHandler, StyleSheet } from 'react-native';

import { useAlarms } from '@/alarms/store';
import { FEATURE_DEFAULTS, fireOut, reminderOut } from '@/api/endpoints';
import type { TaskOut, TodayOut } from '@/api/types';
import type { CalEntry } from '@/calendar/entries';
import * as calService from '@/calendar/service';
import { calState } from '@/calendar/store';
import { addDaysIso, atMinutes, isoDate } from '@/calendar/time';
import { useMinuteClock } from '@/components/ReminderLists';
import { inText, NextUp, nextUpText } from '@/components/today/NextUp';
import { TodayTiles } from '@/components/today/TodayTiles';
import i18n from '@/i18n';
import { useFeatureStore } from '@/store/features';
import { usePages } from '@/store/pages';
import * as taskEdit from '@/tasks/edit';
import * as missedService from '@/today/missed';
import * as todayService from '@/today/service';
import { useToday } from '@/today/service';
import { useTasks } from '@/tasks/store';
import { APP_DIR, atLocalTime, finishOnboarding, resetApp, settle } from '@/testing/helpers';
import { resetWindow, setWindow } from '@/testing/layoutAudit';
import { layoutMetricsFor } from '@/theme';
import { nextUpOf, todayBottom, todaySheetHeight, type NextUpState } from '@/today/v6';

import { flatten, readLocale } from '../../scripts/kk-review';

/**
 * «Сегодня» v6 — the designer's acceptance list (docs/design/system/today-v6-acceptance.md §11, items 1–20).
 * The clock is fixed (`atLocalTime` = fake timers + setSystemTime, local clock of the phone).
 */

const t = i18n.t.bind(i18n);
const tasksPage = () => usePages.getState().pages.find((p) => p.templateKey === 'tasks')!;
const todayIso = () => isoDate(Date.now());

let seq = 0;
function task(o: Partial<TaskOut> & { title: string }): TaskOut {
  seq += 1;
  const id = o.id ?? `t${seq}`;
  const at = new Date(Date.now() - 86_400_000).toISOString();
  return {
    id,
    client_id: id,
    item_id: null,
    list_key: 'todo',
    qty: null,
    where: null,
    due_date: null,
    done: false,
    done_at: null,
    version: 1,
    seq,
    created_at: `${at.slice(0, 19)}.${String(seq).padStart(3, '0')}Z`,
    updated_at: at,
    deleted_at: null,
    ...o,
  };
}
/** A timed to-do on `date` (default today) at `h:m` for `dur` minutes. */
const timed = (title: string, h: number, m = 0, o: Partial<TaskOut> & { date?: string; dur?: number } = {}) =>
  task({ title, start_at: new Date(atMinutes(o.date ?? todayIso(), h * 60 + m)).toISOString(), duration_min: o.dur ?? 60, ...o });
const put = (...list: TaskOut[]) => useTasks.getState().set({ tasks: Object.fromEntries(list.map((x) => [x.id, x])) });
const shoppingOn = () => useFeatureStore.getState().set({ ...FEATURE_DEFAULTS, shopping: true });
const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style) as Record<string, unknown>;
const open = async () => {
  await renderRouter(APP_DIR, { initialUrl: '/' });
  await settle(() => screen.queryByTestId('today-next') !== null);
};

afterEach(() => {
  jest.useRealTimers();
  resetWindow();
});

// A CalEntry for the pure tests.
const entry = (o: Partial<CalEntry> & { title: string; date: string; start: number }): CalEntry => ({
  key: `task:${o.title}:`,
  kind: 'task',
  id: o.title,
  occurrenceAt: null,
  allDay: false,
  duration: 60,
  startMs: atMinutes(o.date, o.start),
  rrule: null,
  done: false,
  source: null,
  itemId: null,
  changedAt: null,
  changedBy: null,
  plan: null,
  pending: false,
  version: 1,
  remind: null,
  ...o,
});

describe('today-v6 §1–§2: the frame', () => {
  it('1. no WeekStrip, no «Не забыть», no «Потрачено сегодня» section; exactly one «План»', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(14);
    put(timed('Стоматолог', 15), task({ title: 'Позвонить маме', due_date: todayIso() }));
    await open();
    expect(screen.queryByTestId('today-week')).toBeNull();
    expect(screen.queryAllByTestId(/^week-\d{4}/)).toHaveLength(0);
    expect(screen.queryByTestId('today-tasks')).toBeNull();
    expect(screen.queryByTestId('tile-spent')).toBeNull();
    expect(screen.queryByTestId('today-tomorrow')).toBeNull();
    expect(screen.queryByTestId('today-waiting')).toBeNull();
    expect(screen.getAllByTestId('today-plan')).toHaveLength(1);
  });

  it.each([
    ['morning', 8, 0],
    ['day', 14, 0],
    ['evening', 20, 0],
    ['night', 23, 30],
  ] as const)('2. %s: the date button, the card and two tiles', async (_p, h, m) => {
    resetApp();
    finishOnboarding('full');
    shoppingOn();
    atLocalTime(h, m);
    put(timed('Планёрка', 9), timed('Ужин', 21), timed('Бассейн', 10, 0, { date: addDaysIso(todayIso(), 1) }));
    await open();
    expect(screen.getByTestId('today-date')).toBeTruthy();
    expect(screen.getByTestId('today-next')).toBeTruthy();
    expect(screen.getByTestId('today-tiles')).toBeTruthy();
    expect(screen.getByTestId('today-tile-spent')).toBeTruthy();
    expect(screen.getByTestId('today-tile-buy')).toBeTruthy();
  });
});

describe('today-v6 §3.2: «Дальше» (NextUp)', () => {
  const today = '2026-11-20';
  const at = (h: number, m = 0) => h * 60 + m;
  const words = (s: NextUpState) => nextUpText(s, t, (d) => `${new Date(`${d}T12:00:00`).toLocaleDateString('ru', { weekday: 'long' })}, ${new Date(`${d}T12:00:00`).getDate()}`);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 10, 20, 8, 20));
  });

  it('3. the six cases: words and the leaf date', () => {
    const first = nextUpOf({ nowMin: at(8, 20), today, period: 'morning', anyDoneToday: false, entries: [entry({ title: 'Планёрка', date: today, start: at(9) })] });
    expect(first).toMatchObject({ kind: 'first', date: today });
    expect(words(first)).toMatchObject({ l1: 'Первое · через 40 мин', l2: '9:00 Планёрка' });

    const going = nextUpOf({ nowMin: at(13, 10), today, period: 'day', anyDoneToday: false, entries: [entry({ title: 'Обед с Мариной', date: today, start: at(13), duration: 30 })] });
    expect(going).toMatchObject({ kind: 'now', date: today });
    expect(words(going)).toMatchObject({ l1: 'Сейчас · ещё 20 мин', l2: '13:00 Обед с Мариной' });

    const next = nextUpOf({
      nowMin: at(14, 10),
      today,
      period: 'day',
      anyDoneToday: true,
      entries: [entry({ title: 'Созвон', date: today, start: at(10), done: true }), entry({ title: 'Стоматолог', date: today, start: at(15) })],
    });
    expect(next).toMatchObject({ kind: 'next', date: today });
    expect(words(next)).toMatchObject({ l1: 'Дальше · через 50 мин', l2: '15:00 Стоматолог' });

    const tomorrow = addDaysIso(today, 1);
    for (const [period, now] of [['evening', at(20)], ['night', at(23, 30)]] as const) {
      // Today's dinner is over (19:00–20:00): the coming day speaks.
      const s = nextUpOf({ nowMin: now, today, period, anyDoneToday: false, entries: [entry({ title: 'Ужин', date: today, start: at(19) }), entry({ title: 'Бассейн', date: tomorrow, start: at(10) })] });
      expect(s).toMatchObject({ kind: 'tomorrow', date: tomorrow });
      expect(words(s)).toMatchObject({ l1: 'Завтра первое', l2: '10:00 Бассейн' });
    }
    // Nothing timed left today in the day: tomorrow too.
    expect(nextUpOf({ nowMin: at(16), today, period: 'day', anyDoneToday: false, entries: [entry({ title: 'Бассейн', date: tomorrow, start: at(10) })] }).kind).toBe('tomorrow');

    const friday = '2026-11-27';
    const near = nextUpOf({ nowMin: at(14), today, period: 'day', anyDoneToday: false, entries: [entry({ title: 'Бассейн', date: friday, start: at(10) })] });
    expect(near).toMatchObject({ kind: 'nearest', date: friday });
    expect(words(near)).toMatchObject({ l1: 'Ближайшее · пятница, 27', l2: '10:00 Бассейн' });

    const none = nextUpOf({ nowMin: at(14), today, period: 'day', anyDoneToday: false, entries: [] });
    expect(none).toMatchObject({ kind: 'none', date: today });
    expect(words(none)).toMatchObject({ l1: 'Дел пока нет', l2: 'Открыть календарь' });
  });

  it('3. the leaf: the weekday band and the number', async () => {
    const view = await render(<NextUp state={{ kind: 'none', entry: null, date: today, minutes: null }} onPress={() => undefined} />);
    expect(view.getByTestId('today-next-leaf-day', { includeHiddenElements: true })).toHaveTextContent('ПТ');
    expect(view.getByTestId('today-next-leaf-num', { includeHiddenElements: true })).toHaveTextContent('20');
  });

  it('4. «через 1 ч 40 мин», «через 50 мин», «сейчас»; a minute later the card says one less', async () => {
    expect(inText(t, 100)).toBe('через 1 ч 40 мин');
    expect(inText(t, 50)).toBe('через 50 мин');
    expect(inText(t, 0)).toBe('сейчас');
    jest.setSystemTime(new Date(2026, 10, 20, 14, 10));
    function Harness() {
      const now = useMinuteClock();
      const d = new Date(now);
      const s = nextUpOf({ nowMin: d.getHours() * 60 + d.getMinutes(), today, period: 'day', anyDoneToday: true, entries: [entry({ title: 'Стоматолог', date: today, start: at(15) })] });
      return <NextUp state={s} onPress={() => undefined} />;
    }
    const view = await render(<Harness />);
    expect(view.getByTestId('today-next-l1')).toHaveTextContent('Дальше · через 50 мин');
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(view.getByTestId('today-next-l1')).toHaveTextContent('Дальше · через 49 мин');
  });

  it.each([
    ['today, in the day', 14, 0, 0],
    ['tomorrow, in the evening', 20, 0, 1],
    ['tomorrow, at night', 23, 30, 1],
    ['the nearest day', 14, 0, 3],
  ] as const)('5. a tap opens the calendar «День» on the leaf: %s', async (_n, h, m, shift) => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(h, m);
    const target = addDaysIso(todayIso(), shift);
    put(timed('Дело', shift === 0 ? 15 : 10, 0, { date: target }));
    calState().set({ view: 'month' });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('today-next') !== null);
    await fireEvent.press(screen.getByTestId('today-next'));
    await settle(() => r.getPathname() === `/page/${tasksPage().id}`);
    expect(calState()).toMatchObject({ view: 'day', date: shift === 0 ? null : target });
  });
});

describe('today-v6 §3.3, §4: the date button and «Другой день»', () => {
  it('6. the date opens the sheet; «Завтра» and a day of the month open the calendar on it and close the sheet', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(11);
    const tomorrow = addDaysIso(todayIso(), 1);
    let r = await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.queryByTestId('today-day-picker')).toBeNull();
    await fireEvent.press(screen.getByTestId('today-date'));
    await settle(() => screen.queryByTestId('today-day-picker') !== null);
    expect(screen.getByTestId('today-day-picker')).toHaveTextContent(/Другой день.*Сегодня.*Завтра, /);
    await fireEvent.press(screen.getByTestId('today-pick-tomorrow'));
    await settle(() => r.getPathname() === `/page/${tasksPage().id}`);
    expect(calState()).toMatchObject({ view: 'day', date: tomorrow });
    await settle(() => screen.queryByTestId('today-day-picker') === null);

    // A day of the month (the next month when it lies there).
    await r.unmount();
    calState().set({ view: 'list', date: null });
    r = await renderRouter(APP_DIR, { initialUrl: '/' });
    const target = addDaysIso(todayIso(), 9);
    await fireEvent.press(screen.getByTestId('today-date'));
    await settle(() => screen.queryByTestId('today-day-picker-grid') !== null);
    if (target.slice(0, 7) !== todayIso().slice(0, 7)) await fireEvent.press(screen.getByTestId('today-day-picker-next'));
    await fireEvent.press(screen.getByTestId(`today-pick-${target}`));
    await settle(() => r.getPathname() === `/page/${tasksPage().id}`);
    expect(calState()).toMatchObject({ view: 'day', date: target });
    expect(screen.queryByTestId('today-day-picker')).toBeNull();
  });

  it('7. Ф-91: back from the calendar on another day → the calendar on today → «Сегодня»', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(11);
    const backs: (() => boolean | null | undefined)[] = [];
    const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
      const f = h as unknown as () => boolean | null | undefined;
      backs.push(f);
      return { remove: () => void backs.splice(backs.indexOf(f), 1) };
    });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.press(screen.getByTestId('today-date'));
    await settle(() => screen.queryByTestId('today-pick-tomorrow') !== null);
    await fireEvent.press(screen.getByTestId('today-pick-tomorrow'));
    await settle(() => r.getPathname() === `/page/${tasksPage().id}` && screen.queryByTestId('cal-screen') !== null);
    const back = async () =>
      act(async () => {
        for (const h of [...backs].reverse()) if (h()) break;
      });
    await back();
    await settle(() => calState().date === null);
    expect(r.getPathname()).toBe(`/page/${tasksPage().id}`);
    await back();
    await settle(() => r.getPathname() === '/');
    spy.mockRestore();
  });
});

describe('today-v6 §3.4: «План»', () => {
  it('8. «Прошло N · не отмечено M», a tap opens it, [Сделано] calls setEntryDone', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(14);
    const a = timed('Созвон', 9, 0, { id: 'a', done: true, done_at: new Date().toISOString() });
    const b = timed('Отчёт', 10, 0, { id: 'b' });
    put(a, b, timed('Стоматолог', 15, 0, { id: 'c' }));
    const spy = jest.spyOn(calService, 'setEntryDone');
    await open();
    expect(screen.getByTestId('today-past-toggle')).toHaveTextContent('Прошло 2 · не отмечено 1');
    expect(screen.queryByTestId('today-past-done-task:b:')).toBeNull();
    await fireEvent.press(screen.getByTestId('today-past-toggle'));
    expect(screen.getByTestId('today-past-toggle').props.accessibilityState.expanded).toBe(true);
    expect(screen.queryByTestId('today-past-done-task:a:')).toBeNull();
    await fireEvent.press(screen.getByTestId('today-past-done-task:b:'));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ key: 'task:b:' }), true);
    await settle(() => screen.getByTestId('today-past-toggle').props.accessibilityLabel.startsWith('Прошло 2'));
    spy.mockRestore();
  });

  it.each([
    [360, 4, 3],
    [412, 5, 2],
  ] as const)('9. at %s dp: %s rows, «Ещё %s» opens «Дела» as the list', async (width, rows, more) => {
    setWindow({ width, height: 800, fontScale: 1 });
    resetApp();
    finishOnboarding('full');
    atLocalTime(14);
    put(...Array.from({ length: 7 }, (_, i) => task({ id: `u${i}`, title: `Дело ${i}`, due_date: todayIso() })));
    calState().set({ view: 'day' });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('today-plan-more') !== null);
    expect(screen.getAllByTestId(/^today-row-todo:/)).toHaveLength(rows);
    expect(screen.getByTestId('today-plan-more')).toHaveTextContent(`Ещё ${more}`);
    await fireEvent.press(screen.getByTestId('today-plan-more'));
    await settle(() => r.getPathname() === `/page/${tasksPage().id}`);
    expect(calState().view).toBe('list');
  });

  it('10. option A: the nearest thing is an ordinary row (no outline in «План»)', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(14);
    put(timed('Стоматолог', 15, 0, { id: 's' }));
    await open();
    expect(screen.queryByTestId('today-plan-next')).toBeNull();
    expect(screen.queryAllByTestId(/^today-next-task/)).toHaveLength(0);
    expect(screen.getByTestId('today-row-task:s:')).toHaveTextContent(/15:00.*Стоматолог/);
    const row = flat('today-row-task:s:');
    expect(row.borderWidth ?? 0).toBe(0);
  });

  it('11. evening: «Осталось с сегодня» ≤ 2 with [На завтра]; «Завтра, суббота» ≤ 3', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(20);
    const today = todayIso();
    const tomorrow = addDaysIso(today, 1);
    put(
      task({ id: 'l1', title: 'Оплатить свет', due_date: today }),
      task({ id: 'l2', title: 'Купить корм', due_date: today }),
      timed('Отчёт', 10, 0, { id: 'l3' }),
      ...[8, 9, 10, 11].map((h) => timed(`Завтра ${h}`, h, 0, { id: `n${h}`, date: tomorrow })),
    );
    const spy = jest.spyOn(taskEdit, 'changeTask');
    await open();
    expect(screen.getByTestId('today-left')).toHaveTextContent(/Осталось с сегодня/);
    expect(screen.getAllByTestId(/^today-to-tomorrow-/)).toHaveLength(2);
    await fireEvent.press(screen.getByTestId('today-to-tomorrow-todo:l1'));
    expect(spy).toHaveBeenCalledWith('l1', { due_date: tomorrow }, expect.stringContaining('Перенёс на завтра'));
    const weekday = new Date(`${tomorrow}T12:00:00`).toLocaleDateString('ru', { weekday: 'long' });
    expect(screen.getByTestId('today-coming')).toHaveTextContent(new RegExp(`Завтра, ${weekday}`));
    expect(screen.getAllByTestId(/^today-row-task:n/)).toHaveLength(3);
    spy.mockRestore();
  });

  it('12. night: tomorrow\'s rows; «Будильник на 8:00 стоит» only when an alarm is set', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(23, 30);
    const tomorrow = addDaysIso(todayIso(), 1);
    put(timed('Бассейн', 10, 0, { id: 'p', date: tomorrow }));
    let view = await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('today-coming') !== null);
    expect(screen.getByTestId('today-coming')).toHaveTextContent(/Бассейн/);
    expect(screen.queryByTestId('today-alarm')).toBeNull();
    await view.unmount();

    const wake = new Date(atMinutes(tomorrow, 8 * 60)).toISOString();
    const r = reminderOut({ id: 'al', title: 'Подъём', due_at: wake, kind: 'normal', status: 'scheduled', level: 'alarm', version: 1 })!;
    const f = fireOut({ id: 'fa', reminder_id: 'al', key: 'al:k:0:0', occurrence_at: wake, fire_at: wake, offset_min: 0, snooze_n: 0, state: 'scheduled' })!;
    useAlarms.setState({ reminders: { al: r }, fires: { [f.key]: f } });
    view = await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('today-alarm') !== null);
    expect(screen.getByTestId('today-alarm')).toHaveTextContent('Будильник на 8:00 стоит');
  });
});

describe('today-v6 §3.5: the tiles (Ф-94)', () => {
  it('13. no spending — «0 ₸», «сегодня трат не было»; an empty list — «Пусто»; shopping off — one tile of half width', async () => {
    resetApp();
    finishOnboarding('full');
    shoppingOn();
    atLocalTime(14);
    let view = await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getByTestId('today-tile-spent-sum')).toHaveTextContent('0 ₸');
    expect(screen.getByTestId('today-tile-spent-sub')).toHaveTextContent('сегодня трат не было');
    expect(screen.getByTestId('today-tile-buy-count')).toHaveTextContent('Пусто');
    expect(screen.getByTestId('today-tile-buy-sub')).toHaveTextContent('скажите «купить хлеб»');
    await view.unmount();

    useFeatureStore.getState().set({ ...FEATURE_DEFAULTS, shopping: false });
    view = await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getByTestId('today-tile-spent')).toBeTruthy();
    expect(screen.queryByTestId('today-tile-buy')).toBeNull();
    // Two equal columns: the spent tile and the blank half.
    expect(flat('today-tile-spent').flex).toBe(1);
    expect(flat('today-tile-blank').flex).toBe(1);
    expect(flat('today-tiles').flexDirection).toBe('row');
  });

  it('14. «Потрачено» opens «Расходы»; «Купить» opens «Покупки», or «Дела» as the list without that page', async () => {
    resetApp();
    finishOnboarding('full');
    shoppingOn();
    atLocalTime(14);
    let r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.press(screen.getByTestId('today-tile-spent'));
    await settle(() => usePages.getState().pages.some((p) => p.templateKey === 'expenses') && r.getPathname().startsWith('/page/'));
    const exp = usePages.getState().pages.find((p) => p.templateKey === 'expenses')!;
    expect(r.getPathname()).toBe(`/page/${exp.id}`);
    await r.unmount();

    calState().set({ view: 'month' });
    r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.press(screen.getByTestId('today-tile-buy'));
    await settle(() => r.getPathname() === `/page/${tasksPage().id}`);
    expect(calState().view).toBe('list');
    await r.unmount();

    const tp = tasksPage();
    usePages.setState((s) => ({ pages: [...s.pages, { ...tp, id: 'shop-page', templateKey: 'shopping', title: 'Покупки', serverId: null }] }));
    r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.press(screen.getByTestId('today-tile-buy'));
    await settle(() => r.getPathname() === '/page/shop-page');
  });
});

describe('today-v6 §3.4 «Сегодня пусто», §3.1 the phrase', () => {
  it('15. an empty day: no «План» (no to-dos without a time); the nearest day without «Календарь ›»; «Три первые фразы»', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(14);
    put(task({ title: 'Забрать посылку', due_date: addDaysIso(todayIso(), 2) }));
    await open();
    await settle(() => screen.queryByTestId('today-first') !== null);
    expect(screen.queryByTestId('today-plan')).toBeNull();
    expect(screen.getByTestId('today-nearest')).toHaveTextContent(/Забрать посылку/);
    expect(screen.queryByTestId('today-calendar')).toBeNull();
    expect(screen.getByTestId('sheet-phrase')).toHaveTextContent(/^Свободный день\. Ближайшее — .+\.$/);
  });

  it('16. plural forms for 1, 2, 5, 21 in RU; the KK keys are there', () => {
    expect([1, 2, 5, 21].map((count) => t('today6.phrase_morning', { count }))).toEqual([
      'Доброе утро.\nСегодня 1 дело.',
      'Доброе утро.\nСегодня 2 дела.',
      'Доброе утро.\nСегодня 5 дел.',
      'Доброе утро.\nСегодня 21 дело.',
    ]);
    expect(t('today6.phrase_day', { count: 5 })).toBe('Добрый день.\nЕщё 5 дел сегодня.');
    expect(t('today6.phrase_night', { count: 2 })).toBe('Спокойной ночи.\nЗавтра 2 дела.');
    expect(t('today6.phrase_evening', { done: 7, all: 8 })).toBe('День позади.\nСделано 7 из 8.');
    const kk = flatten(readLocale('kk'));
    for (const k of ['phrase_morning_one', 'phrase_morning_other', 'phrase_day_other', 'phrase_evening', 'phrase_night_other', 'phrase_free_near', 'phrase_free_none'])
      expect(kk[`today6.${k}`]).toMatch(/\n/);
  });
});

describe('today-v6 §5, §9, §1.2', () => {
  const paddingOf = (): number | undefined => {
    // The paper body is the view right around «today-list».
    const list = screen.getByTestId('today-list');
    let node = list.parent;
    while (node) {
      const st = StyleSheet.flatten(node.props.style) as { paddingBottom?: number } | undefined;
      if (st && typeof st.paddingBottom === 'number' && st.paddingBottom >= 100) return st.paddingBottom;
      node = node.parent;
    }
    return undefined;
  };

  it.each([
    [1, 104],
    [1.3, 112],
  ] as const)('17. the bottom room of «Сегодня» at font ×%s is %s', async (fontScale, room) => {
    setWindow({ width: 360, height: 760, fontScale });
    resetApp();
    finishOnboarding('full');
    atLocalTime(14);
    await open();
    expect(paddingOf()).toBe(room);
    expect(todayBottom(layoutMetricsFor({ width: 360, height: 760, fontScale }))).toBe(room);
  });

  it('18. screen-reader labels of the date, the card and both tiles', async () => {
    resetApp();
    finishOnboarding('full');
    shoppingOn();
    atLocalTime(14, 10);
    put(timed('Стоматолог', 15));
    await open();
    const long = new Date().toLocaleDateString('ru', { weekday: 'long', day: 'numeric', month: 'long' });
    expect(screen.getByTestId('today-date').props.accessibilityLabel).toBe(`${long.charAt(0).toUpperCase()}${long.slice(1)}. Выбрать другой день`);
    expect(screen.getByTestId('today-next').props.accessibilityLabel).toBe('Дальше: 15:00, Стоматолог, через 50 минут. Открыть календарь');
    expect(screen.getByTestId('today-tile-spent').props.accessibilityLabel).toBe('Сегодня трат не было. Открыть расходы');
    expect(screen.getByTestId('today-tile-buy').props.accessibilityLabel).toBe('Список покупок пуст');
    for (const id of ['today-date', 'today-next', 'today-tile-spent', 'today-tile-buy']) expect(screen.getByTestId(id).props.accessibilityRole).toBe('button');

    const tiles = await render(<TodayTiles spentMinor={435_000n} parts={[]} toBuy={['Хлеб', 'Молоко']} shopping onSpent={() => undefined} onBuy={() => undefined} />);
    expect(tiles.getByTestId('today-tile-spent').props.accessibilityLabel).toMatch(/^Потрачено сегодня 4\s350 тенге\. Открыть расходы$/u);
    expect(tiles.getByTestId('today-tile-buy').props.accessibilityLabel).toBe('Купить 2: хлеб, молоко. Открыть покупки');
  });

  it('19. the yellow sheet has one height in every period and card state', async () => {
    for (const w of [320, 360, 412]) for (const fs of [1, 1.3]) {
      const m = layoutMetricsFor({ width: w, height: 800, fontScale: fs });
      expect(todaySheetHeight(m)).toBe(todaySheetHeight({ ...m }));
    }
    const heights: number[] = [];
    for (const [h, m, data] of [
      [8, 0, true],
      [13, 10, true],
      [20, 0, true],
      [23, 30, true],
      [14, 0, false],
    ] as const) {
      resetApp();
      finishOnboarding('full');
      atLocalTime(h, m);
      if (data) put(timed('Планёрка', 9), timed('Обед', 13, 0, { dur: 30 }), timed('Бассейн', 10, 0, { date: addDaysIso(todayIso(), 1) }));
      const view = await renderRouter(APP_DIR, { initialUrl: '/' });
      await settle(() => screen.queryByTestId('today-next') !== null);
      heights.push(flat('today-header').height as number);
      await view.unmount();
    }
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBe(todaySheetHeight(layoutMetricsFor({ width: 390, height: 844, fontScale: 1 })));
  });

  it('20. the i18n keys of the removed UI are gone from ru.json and kk.json', () => {
    const ru = flatten(readLocale('ru'));
    const kk = flatten(readLocale('kk'));
    const gone = [
      'today.dv_free_5',
      'today.dv_name_5',
      'today.dv_add_5',
      'today.dv_plan',
      'today.dv_swipe',
      'today.dv_past_phrase',
      'today.not_forget',
      'today.spent_today_title',
      'today.shopping_hint',
      'today.on_pages',
      'today.tile_menu_a11y',
      'today.buy_one',
      'today.buy_more',
      'today.waiting',
      'today.missed_title',
      'today.e_blank',
      'today.e_nearest',
      'today.phrase_tasks_one',
      'todayTime.morning_first',
      'todayTime.day_free_until',
      'todayTime.next',
      'todayTime.unmarked',
      'todayTime.was_at',
      'todayTime.calendar',
    ];
    for (const k of gone) {
      expect([k, ru[k]]).toEqual([k, undefined]);
      expect([k, kk[k]]).toEqual([k, undefined]);
    }
    // The calendar keeps its words («Добавить на пятницу…», the empty day) and the week of «Дела».
    for (const k of ['today.dv_ask_5', 'today.dv_title_5', 'today.week_day_one']) expect(ru[k]).toBeDefined();
  });
});

describe('today-v6 review 1 (docs/design/qa/today-v6-review-1.md)', () => {
  it.each([
    ['evening', 18, 30, 19, 0],
    ['night before midnight', 23, 10, 23, 40],
  ] as const)('21. Р1 %s with a timed thing still ahead today: «Дальше», the row in «План», «Добрый вечер.»', async (_n, h, m, th, tm) => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(h, m);
    const tomorrow = addDaysIso(todayIso(), 1);
    put(timed('Ужин', th, tm, { id: 'd', dur: 15 }), timed('Бассейн', 10, 0, { id: 'p', date: tomorrow }));
    await open();
    expect(screen.getByTestId('today-next-l1')).toHaveTextContent('Дальше · через 30 мин');
    expect(screen.getByTestId('today-plan')).toHaveTextContent(/План/);
    expect(screen.getByTestId('today-row-task:d:')).toHaveTextContent(new RegExp(`${th}:${String(tm).padStart(2, '0')}.*Ужин`));
    expect(screen.queryByTestId('today-left')).toBeNull();
    expect(screen.getByTestId('today-coming')).toHaveTextContent(/Завтра, .*Бассейн/);
    expect(screen.getByTestId('sheet-phrase')).toHaveTextContent('Добрый вечер. Ещё 1 дело сегодня.');
  });

  it('22. Р2 a reminder missed yesterday at 22:00: at 08:00 «Прошло 1 · не отмечено 1», «вчера», [Сделано] → markMissedDone', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(8);
    const due = atMinutes(addDaysIso(todayIso(), -1), 22 * 60);
    const r = reminderOut({ id: 'rs', title: 'Оплатить свет', due_at: new Date(due).toISOString(), kind: 'normal', status: 'scheduled', level: 'notification', version: 1 })!;
    const iso = new Date(due).toISOString();
    const f = fireOut({ id: 'fs', reminder_id: 'rs', key: 'rs:k:0:0', occurrence_at: iso, fire_at: iso, offset_min: 0, snooze_n: 0, state: 'missed' })!;
    useAlarms.setState({ reminders: { rs: r }, fires: { [f.key]: f } });
    const spy = jest.spyOn(missedService, 'markMissedDone').mockResolvedValue(undefined);
    await open();
    expect(screen.getByTestId('today-past-toggle')).toHaveTextContent('Прошло 1 · не отмечено 1');
    await fireEvent.press(screen.getByTestId('today-past-toggle'));
    const key = `reminder:rs:${due}`;
    expect(screen.getByTestId(`today-row-${key}`)).toHaveTextContent(/22:00.*Оплатить свет.*вчера/);
    await fireEvent.press(screen.getByTestId(`today-past-done-${key}`));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ key: f.key, reminderId: 'rs' }), expect.any(Function));
    spy.mockRestore();
  });

  it('23. Р3 proposals on: after the tiles in the tip look, at most 2 lines with the tip; [Да] calls sayYes', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(14);
    useFeatureStore.getState().set({ ...FEATURE_DEFAULTS, today: { ...FEATURE_DEFAULTS.today, proposals: true, tips_per_day: 1, tips_days: 0 } });
    const prop = (id: string) => ({ id, kind: 'data_proposal', key: 'task_from_item', text_ru: `Добавить в дела ${id}?`, yes_label: 'Да, добавить', no_label: 'Не сейчас', do: { type: 'accept' }, status: 'shown' });
    useToday.setState({
      last: {
        date: null, tz: null, greeting: null, sections: [], today: { reminders: [], tasks: [], shopping: null }, missed: [],
        done_for_you: { actions: [], count_today: 0 }, banner: null, proposals: [prop('p1'), prop('p2')],
        tip: { id: 'tp', kind: 'tip', key: 'say_reminder', text_ru: 'Скажите: «Напомни в 8»', yes_label: null, no_label: 'Не сейчас', do: null, status: 'shown' },
        empty: false, example: null, page_tiles: [],
      } as unknown as TodayOut,
    });
    const yes = jest.spyOn(todayService, 'sayYes').mockResolvedValue(undefined as never);
    await open();
    expect(screen.getByTestId('suggestion-p1')).toHaveTextContent(/Добавить в дела p1\?.*Да, добавить.*Не сейчас/);
    expect(screen.getByTestId('suggestion-p2')).toBeTruthy();
    // Two lines at most: two proposals leave no room for the tip.
    expect(screen.queryByTestId('suggestion-tp')).toBeNull();
    // After the tiles: the order of the testIDs on the paper.
    const ids: string[] = [];
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return;
      const el = n as { props?: { testID?: string }; children?: unknown[] };
      if (el.props?.testID) ids.push(el.props.testID);
      for (const c of el.children ?? []) walk(c);
    };
    walk(screen.toJSON());
    expect(ids.indexOf('today-tiles')).toBeGreaterThan(-1);
    expect(ids.indexOf('suggestion-p1')).toBeGreaterThan(ids.indexOf('today-tiles'));
    expect(StyleSheet.flatten(screen.getByTestId('today-tips').props.style).gap).toBe(12);
    await fireEvent.press(screen.getByTestId('suggestion-yes-p1'));
    expect(yes).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
    yes.mockRestore();
  });
});
