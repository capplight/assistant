import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { BackHandler } from 'react-native';

import type { ReminderOut, TaskOccurrenceOut, TaskOut } from '@/api/types';
import { blockStates, buildEntries, taskEntryKey, windowAhead, type CalEntry, type EntrySources } from '@/calendar/entries';
import {
  blockBox,
  blockX,
  centerScroll,
  dragDuration,
  dragStart,
  drawnSpan,
  GRID,
  gridAsRows,
  gridHeight,
  halfHourOf,
  initialScroll,
  minuteAt,
  multiDayColumns,
  snap,
  yOf,
} from '@/calendar/geometry';
import { backStep, pageStep, switchView } from '@/calendar/nav';
import { layoutColumn } from '@/calendar/overlap';
import { dayPeriod } from '@/calendar/period';
import { occurrences, parseRule } from '@/calendar/rrule';
import { calendarSink, deleteEntry, focusFromAssistant, followsFocus, moveEntry, setEntryDone } from '@/calendar/service';
import { calState } from '@/calendar/store';
import { addDaysIso, atMinutes, isoDate, isoWithOffset, monthGrid, weekDays } from '@/calendar/time';
import { InMemoryCalendarRepository, SqliteCalendarRepository } from '@/db/calendar';
import { migrate, OUTBOX_MIGRATIONS, type SqlDb } from '@/db/outbox';
import i18n from '@/i18n';
import { usePages } from '@/store/pages';
import { useTasks } from '@/tasks/store';
import { useUndo } from '@/store/undo';
import { APP_DIR, atLocalTime, finishOnboarding, resetApp, settle } from '@/testing/helpers';
import { todPeriod, todPhrase } from '@/today/timeOfDay';

/** Ф-89 / Ф-90 / Ф-91: the time calendar (direction A) and «Сегодня» by the time of day. */

const t = i18n.t.bind(i18n);
const task = (o: Partial<TaskOut> & { id: string }): TaskOut => ({
  client_id: null,
  item_id: null,
  list_key: 'todo',
  title: o.id,
  qty: null,
  where: null,
  due_date: null,
  done: false,
  done_at: null,
  version: 1,
  seq: 1,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  deleted_at: null,
  ...o,
});
const src = (o: Partial<EntrySources> = {}): EntrySources => ({
  tasks: {},
  isDone: (x) => x.done,
  reminders: {},
  fires: {},
  acked: () => false,
  occurrences: {},
  timeEdits: {},
  occEdits: {},
  seriesEnds: {},
  server: {},
  ...o,
});
const DAY = '2026-11-20';
const at = (min: number, date = DAY) => atMinutes(date, min);

describe('grid geometry (calendar-time.md §3: 60 dp an hour, 56 time column, no measures)', () => {
  it('a block of 10:00–11:00 sits like the mock (top 8 + 600 + 1, height 58); a point is 28; at least 28', () => {
    expect(yOf(0)).toBe(GRID.pad);
    expect(blockBox(600, 60)).toEqual({ top: 8 + 600 + 1, height: 58 });
    expect(blockBox(600, null)).toEqual({ top: 609, height: 28 });
    expect(blockBox(600, 15).height).toBe(28);
    expect(gridHeight()).toBe(16 + 1440);
    expect(minuteAt(yOf(615))).toBe(615);
    expect(minuteAt(-50)).toBe(0);
    expect(minuteAt(99999)).toBe(1439);
  });

  it('two side by side share the column with a gap of 6; «+N» leaves 36 + 4 (calendar-time.html dense day)', () => {
    const w = 375;
    const colW = w - 56;
    expect(blockX({ width: w, col: 0, cols: 1, lane: 0, lanes: 1 })).toEqual({ left: 59, width: colW - 6 });
    const b = blockX({ width: w, col: 0, cols: 1, lane: 1, lanes: 2, narrow: true });
    expect(b.left).toBeCloseTo(56 + colW / 2 + 3);
    expect(b.width).toBeCloseTo(colW / 2 - 6 - 40);
    const three = blockX({ width: w, col: 2, cols: 3, lane: 0, lanes: 1 });
    expect(three.left).toBeCloseTo(56 + (colW / 3) * 2 + 3);
  });

  it('opens with «now» at a third of the height; another day at the first block − 30 min; an empty day at 9:00', () => {
    expect(initialScroll({ viewport: 600, now: 9 * 60 + 41, first: null })).toBe(Math.round(yOf(581) - 200));
    expect(initialScroll({ viewport: 600, now: null, first: 600 })).toBe(yOf(570));
    expect(initialScroll({ viewport: 600, now: null, first: null })).toBe(yOf(540));
    expect(initialScroll({ viewport: 600, now: 10, first: null })).toBe(0);
    expect(initialScroll({ viewport: 600, now: 1439, first: null })).toBe(gridHeight() - 600 + GRID.bottomRoom);
    expect(centerScroll({ viewport: 600, start: 900, duration: 60 })).toBe(Math.round(yOf(900) + 1 + 29 - 300));
  });

  it('phones show «3 дня», ≥ 600 dp a week; large font or ≤ 340 dp reads as rows', () => {
    expect(multiDayColumns(360)).toBe(3);
    expect(multiDayColumns(600)).toBe(7);
    expect(gridAsRows({ largeText: true, width: 400 })).toBe(true);
    expect(gridAsRows({ largeText: false, width: 340 })).toBe(true);
    expect(gridAsRows({ largeText: false, width: 360 })).toBe(false);
  });
});

describe('drag snapping (§4: 15-min steps, inside the day)', () => {
  it('moves by the nearest 15 minutes and never past the day', () => {
    expect(snap(607)).toBe(600);
    expect(snap(608)).toBe(615);
    expect(dragStart(600, 20, 60)).toBe(615);
    expect(dragStart(600, 7, 60)).toBe(600);
    expect(dragStart(600, -52, 60)).toBe(555);
    expect(dragStart(30, -500, 60)).toBe(0);
    expect(dragStart(1380, 500, 60)).toBe(1440 - 15);
  });
  it('resizes in steps, at least 15 min, never past midnight; a pull on empty time draws from the pressed step', () => {
    expect(dragDuration(600, 60, 31)).toBe(90);
    expect(dragDuration(600, 60, -200)).toBe(15);
    expect(dragDuration(1400, 30, 500)).toBe(40);
    expect(drawnSpan(607, 0)).toEqual({ start: 600, duration: 15 });
    expect(drawnSpan(607, 98)).toEqual({ start: 600, duration: 105 });
    expect(halfHourOf(14 * 60 + 47)).toBe(14 * 60 + 30);
  });
});

describe('overlaps (§3: at most two side by side, the rest «+N»)', () => {
  it('lays out apart, side by side, and folds a third into «+N» of its hour', () => {
    const apart = layoutColumn([
      { key: 'a', start: 600, duration: 60 },
      { key: 'b', start: 700, duration: 30 },
    ]);
    expect(apart.placed.map((p) => [p.key, p.lane, p.lanes])).toEqual([
      ['a', 0, 1],
      ['b', 0, 1],
    ]);
    const two = layoutColumn([
      { key: 'lunch', start: 750, duration: 45 },
      { key: 'call', start: 765, duration: 60 },
    ]);
    expect(two.placed.map((p) => [p.key, p.lane, p.lanes])).toEqual([
      ['lunch', 0, 2],
      ['call', 1, 2],
    ]);
    expect(two.more).toEqual([]);
    const dense = layoutColumn([
      { key: 'long', start: 600, duration: 90 },
      { key: 'short', start: 600, duration: 45 },
      { key: 'x', start: 610, duration: 30 },
      { key: 'y', start: 615, duration: 30 },
      { key: 'later', start: 780, duration: 90 },
    ]);
    expect(dense.placed.map((p) => p.key).sort()).toEqual(['later', 'long', 'short']);
    expect(dense.more).toEqual([{ start: 610, keys: ['x', 'y'] }]);
    const short = dense.placed.find((p) => p.key === 'short')!;
    expect(short).toMatchObject({ lane: 1, lanes: 2, narrow: true });
    expect(dense.placed.find((p) => p.key === 'long')!.narrow).toBe(false);
    expect(dense.placed.find((p) => p.key === 'later')!.lanes).toBe(1);
  });
});

describe('time of day (Ф-91: morning to 11:00, evening from 18:00, night from 23:00)', () => {
  it('the default bounds', () => {
    const p = (h: number, m = 0) => dayPeriod({ now: h * 60 + m });
    expect(p(4, 59)).toBe('night');
    expect(p(5)).toBe('morning');
    expect(p(10, 59)).toBe('morning');
    expect(p(11)).toBe('day');
    expect(p(17, 59)).toBe('day');
    expect(p(18)).toBe('evening');
    expect(p(22, 59)).toBe('evening');
    expect(p(23)).toBe('night');
    expect(p(0)).toBe('night');
  });
  it('the morning ends early, the evening starts early, quiet hours move the night', () => {
    expect(dayPeriod({ now: 615, timed: [{ start: 540, end: 570 }, { start: 720, end: 780 }] })).toBe('day');
    expect(dayPeriod({ now: 600, timed: [{ start: 540, end: 570 }] })).toBe('morning');
    expect(dayPeriod({ now: 16 * 60 + 30, timed: [{ start: 600, end: 660 }] })).toBe('evening');
    expect(dayPeriod({ now: 15 * 60, timed: [{ start: 600, end: 660 }] })).toBe('day');
    expect(dayPeriod({ now: 16 * 60 + 30 })).toBe('day');
    expect(dayPeriod({ now: 22 * 60, quiet: { from: 22 * 60, to: 7 * 60 } })).toBe('night');
    expect(dayPeriod({ now: 6 * 60, quiet: { from: 22 * 60, to: 7 * 60 } })).toBe('night');
    expect(dayPeriod({ now: 7 * 60, quiet: { from: 22 * 60, to: 7 * 60 } })).toBe('morning');
  });
  it('the phrase is always two lines of templates (today-v6 §3.1), no time in it: the time is in the card', () => {
    const today = [
      { start: 570, duration: 60 },
      { start: 900, duration: 60 },
      { start: 1140, duration: 60 },
    ];
    const c = { all: 3, done: 1, ahead: 2, coming: 4, emptyToday: false, nearest: 'завтра' };
    const at = (now: number) => todPhrase(todPeriod({ now, today }), c, t);
    expect(at(7 * 60 + 40)).toBe('Доброе утро.\nСегодня 3 дела.');
    expect(at(13 * 60 + 20)).toBe('Добрый день.\nЕщё 2 дела сегодня.');
    expect(at(20 * 60 + 30)).toBe('День позади.\nСделано 1 из 3.');
    expect(at(23 * 60 + 30)).toBe('Спокойной ночи.\nЗавтра 4 дела.');
    for (const n of [7 * 60, 13 * 60, 20 * 60, 23 * 60 + 30]) expect(at(n).split('\n')).toHaveLength(2);
    // An empty today: «Свободный день.» and the nearest day, or nothing in 7 days.
    expect(todPhrase('day', { ...c, emptyToday: true, nearest: 'пятница' }, t)).toBe('Свободный день.\nБлижайшее — пятница.');
    expect(todPhrase('morning', { ...c, emptyToday: true, nearest: null }, t)).toBe('Свободный день.\nДел пока нет.');
    expect(todPhrase('night', { ...c, coming: 0, emptyToday: true, nearest: null }, t)).toBe('Свободный день.\nДел пока нет.');
  });
});

describe('the one back (Ф-91: another day → the calendar on today → where it came from)', () => {
  it('paging days or views never stacks steps', () => {
    const today = '2026-11-19';
    let nav = { view: 'day' as const, date: today } as { view: 'day' | 'multi' | 'month' | 'list'; date: string };
    for (let i = 0; i < 5; i += 1) nav = pageStep(nav, 1);
    nav = switchView(nav, 'multi');
    nav = pageStep(nav, -1, 3);
    expect(nav).toEqual({ view: 'multi', date: '2026-11-21' });
    const first = backStep(nav, today);
    expect(first).toEqual({ kind: 'today', nav: { view: 'multi', date: today } });
    expect(backStep(first.kind === 'today' ? first.nav : nav, today)).toEqual({ kind: 'leave' });
    expect(pageStep({ view: 'month', date: '2026-12-15' }, 1).date).toBe('2027-01-01');
    expect(backStep({ view: 'list', date: '2026-12-01' }, today)).toEqual({ kind: 'leave' });
  });
});

describe('repeats and entries (calendar.md «The model»)', () => {
  it('expands DAILY / WEEKLY BYDAY / MONTHLY with INTERVAL and UNTIL on the local clock', () => {
    const start = atMinutes('2026-11-02', 9 * 60); // Monday 9:00
    const range = [atMinutes('2026-11-01', 0), atMinutes('2026-11-30', 0)] as const;
    expect(occurrences('FREQ=DAILY;INTERVAL=7', start, ...range).map(isoDate)).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);
    expect(occurrences('FREQ=WEEKLY;BYDAY=TU,TH', start, range[0], atMinutes('2026-11-14', 0)).map(isoDate)).toEqual([
      '2026-11-03',
      '2026-11-05',
      '2026-11-10',
      '2026-11-12',
    ]);
    const jan31 = atMinutes('2027-01-31', 600);
    expect(occurrences('FREQ=MONTHLY', jan31, jan31, atMinutes('2027-06-01', 0)).map(isoDate)).toEqual(['2027-01-31', '2027-03-31', '2027-05-31']);
    const until = parseRule('FREQ=DAILY;UNTIL=20261104T235959Z')!.until!;
    expect(occurrences('FREQ=DAILY;UNTIL=20261104T235959Z', start, ...range).every((ms) => ms <= until)).toBe(true);
    expect(occurrences(null, start, ...range)).toEqual([start]);
  });

  it('builds blocks: a timed to-do, a moved / skipped / done occurrence, a move by hand on its way, an all-day one', () => {
    const series = task({ id: 'run', title: 'Пробежка', start_at: new Date(at(9 * 60, '2026-11-18')).toISOString(), duration_min: 30, rrule: 'FREQ=DAILY' });
    const meet = task({ id: 'meet', title: 'Встреча', start_at: new Date(at(15 * 60)).toISOString(), duration_min: 60, item_id: 'i-meet' });
    const bills = task({ id: 'bills', title: 'Оплатить свет', due_date: DAY });
    const occ = (ms: number, o: Partial<TaskOccurrenceOut>): TaskOccurrenceOut => ({
      id: `o-${ms}`,
      task_id: 'run',
      occurrence_at: new Date(ms).toISOString(),
      start_at: null,
      duration_min: null,
      done_at: null,
      skipped: false,
      version: 1,
      seq: 1,
      updated_at: '2026-11-19T00:00:00Z',
      ...o,
    });
    const o20 = at(540);
    const o21 = at(540, '2026-11-21');
    const o22 = at(540, '2026-11-22');
    const rem: ReminderOut = {
      id: 'r1', client_id: null, title: 'Встреча', body: null, due_at: new Date(at(14 * 60 + 45)).toISOString(), tz: 'Asia/Almaty', local: null,
      rrule: null, offsets: [15], level: 'notification', kind: 'normal', created_via: null, parse_source: null, sensitivity: null,
      status: 'scheduled', snooze_until: null, item_id: 'i-meet', when_text: null, version: 1, seq: 1, created_at: '', updated_at: '', deleted_at: null,
    };
    const pill: ReminderOut = { ...rem, id: 'r2', title: 'Таблетка', item_id: null, due_at: new Date(at(18 * 60)).toISOString() };
    const s = src({
      tasks: { run: series, meet, bills },
      reminders: { r1: rem, r2: pill },
      occurrences: {
        a: occ(o20, { start_at: new Date(at(600)).toISOString(), duration_min: 45 }),
        b: occ(o21, { skipped: true }),
        c: occ(o22, { done_at: '2026-11-22T05:00:00Z' }),
      },
      timeEdits: { [taskEntryKey('meet', null)]: { startMs: at(16 * 60), duration: 60, clientId: 'c1' } },
    });
    const list = buildEntries(s, DAY, '2026-11-22');
    const day = list.filter((e) => e.date === DAY);
    expect(day.map((e) => [e.title, e.allDay, e.start, e.duration])).toEqual([
      ['Оплатить свет', true, null, null],
      ['Пробежка', false, 600, 45],
      ['Встреча', false, 960, 60],
      ['Таблетка', false, 1080, null],
    ]);
    // The linked reminder is the meeting's alert, not a block of its own; it shows in the card.
    expect(day.find((e) => e.title === 'Встреча')).toMatchObject({ pending: true, remind: { id: 'r1', offsets: [15] } });
    expect(list.filter((e) => e.date === '2026-11-21' && e.title === 'Пробежка')).toEqual([]);
    expect(list.find((e) => e.date === '2026-11-22' && e.title === 'Пробежка')).toMatchObject({ done: true, occurrenceAt: new Date(o22).toISOString() });
    // «Это и следующие» deleted by hand: nothing from that occurrence on.
    const cut = buildEntries({ ...s, seriesEnds: { run: { from: o21 } } }, DAY, '2026-11-22');
    expect(cut.filter((e) => e.title === 'Пробежка').map((e) => e.date)).toEqual([DAY]);
  });

  it('states: now = ink, the next one outlined, past not done «прошло», done struck; the window to the next', () => {
    const now = at(13 * 60 + 20);
    const e = (key: string, start: number, duration: number, done = false) => ({
      key, kind: 'task' as const, id: key, occurrenceAt: null, title: key, date: DAY, allDay: false, start, duration,
      startMs: at(start), rrule: null, done, source: null, itemId: null, changedAt: null, changedBy: null, plan: null, pending: false, version: 1, remind: null,
    });
    const list = [e('a', 540, 30, true), e('b', 660, 60), e('c', 780, 60), e('d', 900, 60), e('f', 1110, 30)];
    const st = blockStates(list, now);
    expect([...st.entries()]).toEqual([
      ['a', 'done'],
      ['b', 'past'],
      ['c', 'current'],
      ['d', 'next'],
      ['f', 'plain'],
    ]);
    expect(windowAhead(list, now)).toBeNull();
    expect(windowAhead(list, at(14 * 60 + 5))).toEqual({ start: 845, end: 900 });
    expect(windowAhead(list, at(14 * 60 + 40))).toBeNull();
  });

  it('the assistant focus follows today or the same day, never a day the person browses', () => {
    const f = focusFromAssistant([task({ id: 't1', start_at: new Date(at(900, '2026-11-21')).toISOString() })], at(600))!;
    expect(f).toMatchObject({ taskId: 't1', date: '2026-11-21', startMin: 900, until: at(600) + 1500 });
    expect(calState().focus?.seq).toBe(f.seq);
    expect(followsFocus(DAY, f, DAY)).toBe(true);
    expect(followsFocus('2026-11-21', f, DAY)).toBe(true);
    expect(followsFocus('2026-11-25', f, DAY)).toBe(false);
  });

  it('local dates and the start with the phone offset', () => {
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekDays('2026-11-20')[0]).toBe('2026-11-16');
    expect(monthGrid('2026-11-20')).toHaveLength(42);
    expect(monthGrid('2026-11-20')[0]).toBe('2026-10-26');
    expect(isoWithOffset(at(600))).toMatch(/^2026-11-20T10:00:00[+-]\d{2}:\d{2}$/);
  });
});

// --- the local migration v13 (real SQLite where Node has it) ---

type NodeDb = { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown } };
let sqlite: { DatabaseSync: new (path: string) => NodeDb } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}
const open = (): SqlDb => {
  const db = new sqlite!.DatabaseSync(':memory:');
  return {
    execAsync: async (sql: string) => db.exec(sql),
    runAsync: async (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
    getAllAsync: async (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p),
    getFirstAsync: async (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) ?? null,
  } as unknown as SqlDb;
};
const occOut = (id: string, seq: number, o: Partial<TaskOccurrenceOut> = {}): TaskOccurrenceOut => ({
  id, task_id: 'run', occurrence_at: '2026-11-21T04:00:00+00:00', start_at: null, duration_min: null, done_at: null, skipped: false, version: 1, seq, updated_at: '2026-11-20T00:00:00Z', ...o,
});

(sqlite ? describe : describe.skip)('local migration v13 (task_occurrences, calendar_entries)', () => {
  it('a v12 database upgrades to v13 and keeps occurrences and kept entries', async () => {
    const db = open();
    for (let v = 0; v < 12; v += 1) await db.execAsync(OUTBOX_MIGRATIONS[v]!);
    await db.execAsync('PRAGMA user_version = 12');
    expect(OUTBOX_MIGRATIONS).toHaveLength(13);
    await migrate(db);
    await migrate(db);
    expect((await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version).toBe(13);
    const repo = new SqliteCalendarRepository(db);
    await repo.putOccurrences([occOut('o1', 2, { done_at: '2026-11-21T05:00:00Z' })]);
    await repo.putOccurrences([occOut('o1', 1)]); // older: ignored
    expect(await repo.listOccurrences()).toEqual([occOut('o1', 2, { done_at: '2026-11-21T05:00:00Z' })]);
    const entry = { key: 'plan_step:p:st2', kind: 'plan_step' as const, id: 'st2', occurrence_at: null, title: 'Купить плитку', date: '2026-11-22', all_day: false, start_at: null, end_at: null, start: '10:30', end: null, duration_min: null, rrule: null, moved: false, done: false, source: null, item_id: null, page_id: null, reminder: null, plan: { id: 'p', title: 'Ремонт' }, version: 1 };
    await repo.putRange('2026-11-20', '2026-11-22', [entry], 1);
    expect(await repo.listRange('2026-11-01', '2026-11-30')).toEqual([entry]);
    await repo.putRange('2026-11-20', '2026-11-22', [], 2);
    expect(await repo.listRange('2026-11-01', '2026-11-30')).toEqual([]);
    await repo.removeOccurrence('o1');
    expect(await repo.listOccurrences()).toEqual([]);
  });
});

it('the in-memory calendar repository keeps the newest occurrence', async () => {
  const r = new InMemoryCalendarRepository();
  await r.putOccurrences([occOut('o', 3)]);
  await r.putOccurrences([occOut('o', 2, { skipped: true })]);
  expect((await r.listOccurrences())[0]!.skipped).toBe(false);
});

// --- the screens ---

const tasksPage = () => usePages.getState().pages.find((p) => p.templateKey === 'tasks')!;

describe('«Дела» as a calendar (A0–A5)', () => {
  it('Day: «‹» · month · «⋯», the four views, no «+», a block opens its card; «Удалить» goes at once with «Восстановить»', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    const today = isoDate(Date.now());
    const start = new Date(atMinutes(today, 23 * 60)).toISOString();
    useTasks.getState().set({ tasks: { m1: task({ id: 'm1', title: 'Встреча', start_at: start, duration_min: 30, due_date: today }) } });
    calState().set({ view: 'day' });
    await renderRouter(APP_DIR, { initialUrl: `/page/${tasksPage().id}` });
    await settle(() => screen.queryByTestId('cal-screen') !== null);
    expect(screen.getByTestId('cal-back')).toBeTruthy();
    expect(screen.queryByTestId('page-add')).toBeNull();
    expect(screen.queryByText('К сегодня')).toBeNull();
    for (const v of ['list', 'day', 'multi', 'month']) expect(screen.getByTestId(`cal-view-${v}`)).toBeTruthy();
    expect(screen.getByTestId('cal-view-multi')).toHaveTextContent('3 дня');
    expect(screen.getByTestId('cal-allday')).toHaveTextContent(/ничего/);
    const key = taskEntryKey('m1', null);
    await settle(() => screen.queryByTestId(`cal-block-${key}`) !== null);
    await fireEvent.press(screen.getByTestId(`cal-block-${key}`));
    await settle(() => screen.queryByTestId('cal-card') !== null);
    expect(screen.getByTestId('cal-card-when')).toHaveTextContent(/23:00–23:30 · 30 мин/);
    await fireEvent.press(screen.getByTestId('cal-card-delete'));
    await settle(() => useTasks.getState().tasks.m1?.deleted_at != null);
    await settle(() => false, 20).catch(() => undefined);
    const rows = await outbox.listPending(50);
    expect(rows.some((r) => r.kind === 'calendar.delete')).toBe(true);
    const strip = useUndo.getState().strip;
    expect(strip?.kind === 'custom' ? [strip.text, strip.undoLabel] : null).toEqual(['Удалено: «Встреча»', 'Восстановить']);
    expect(screen.queryByTestId(`cal-block-${key}`)).toBeNull();
  });

  it('a tap on empty time opens A4 with the time; «Добавить» makes a timed to-do through the outbox', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    calState().set({ view: 'day' });
    await renderRouter(APP_DIR, { initialUrl: `/page/${tasksPage().id}` });
    await settle(() => screen.queryByTestId('cal-screen') !== null);
    // A screen reader's invisible hour button stands for the tap on that hour.
    await fireEvent.press(screen.getAllByLabelText('22:00, свободно. Добавить')[0]!);
    await settle(() => screen.queryByTestId('cal-add') !== null);
    expect(screen.getByTestId('cal-add-when')).toHaveTextContent(/22:00/);
    await fireEvent.press(screen.getByTestId('cal-add-dur-30'));
    await fireEvent.changeText(screen.getByTestId('cal-add-title'), 'Созвон');
    await fireEvent.press(screen.getByTestId('cal-add-save'));
    await settle(() => Object.values(useTasks.getState().tasks).some((x) => x.title === 'Созвон'));
    const made = Object.values(useTasks.getState().tasks).find((x) => x.title === 'Созвон')!;
    expect(made.duration_min).toBe(30);
    expect(new Date(made.start_at!).getHours()).toBe(22);
    await settle(() => false, 20).catch(() => undefined);
    const row = (await outbox.listPending(50)).find((r) => r.kind === 'task.create')!;
    expect((row.payload as { body: Record<string, unknown> }).body).toMatchObject({ title: 'Созвон', duration_min: 30 });
    expect(typeof (row.payload as { body: Record<string, unknown> }).body.start_at).toBe('string');
  });

  it('the back steps: another day → today (same view) → «Сегодня»; the system back does the same', async () => {
    resetApp();
    finishOnboarding('full');
    const today = isoDate(Date.now());
    calState().set({ view: 'month', date: addDaysIso(today, 40) });
    const backs: (() => boolean | null | undefined)[] = [];
    const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
      const f = h as unknown as () => boolean | null | undefined;
      backs.push(f);
      return { remove: () => void backs.splice(backs.indexOf(f), 1) };
    });
    const r = await renderRouter(APP_DIR, { initialUrl: `/page/${tasksPage().id}` });
    await settle(() => screen.queryByTestId('cal-month-view') !== null);
    await fireEvent.press(screen.getByTestId('cal-back'));
    expect(calState().date).toBeNull();
    expect(calState().view).toBe('month');
    expect(r.getPathname()).toBe(`/page/${tasksPage().id}`);
    await act(async () => calState().set({ date: addDaysIso(today, 3) }));
    // The system back does what the arrow does.
    await act(async () => {
      for (const h of [...backs].reverse()) if (h()) break;
    });
    await settle(() => calState().date === null);
    await act(async () => {
      for (const h of [...backs].reverse()) if (h()) break;
    });
    await settle(() => r.getPathname() === '/');
    expect(r.getPathname()).toBe('/');
    spy.mockRestore();
  });

  it('the switch goes to «Список» and back; the list keeps its «+»', async () => {
    resetApp();
    finishOnboarding('full');
    calState().set({ view: 'day' });
    await renderRouter(APP_DIR, { initialUrl: `/page/${tasksPage().id}` });
    await settle(() => screen.queryByTestId('cal-screen') !== null);
    await fireEvent.press(screen.getByTestId('cal-view-list'));
    await settle(() => screen.queryByTestId('page-add') !== null);
    expect(screen.getByTestId('cal-view-list').props.accessibilityState.selected).toBe(true);
    await fireEvent.press(screen.getByTestId('cal-view-multi'));
    await settle(() => screen.queryByTestId('cal-colheads') !== null);
    expect(screen.queryByTestId('page-add')).toBeNull();
  });
});

describe('«Сегодня»: the calendar entry and the list (calendar-time.md §14)', () => {
  afterEach(() => jest.useRealTimers());
  it('§14.1: an empty day has no «План дня» and no «свободно»; nothing in 7 days — no «Календарь ›»', async () => {
    resetApp();
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('today-list') !== null);
    expect(screen.queryByTestId('today-plan-head')).toBeNull();
    expect(screen.queryByTestId('today-plan-free')).toBeNull();
    expect(screen.queryByText('свободно')).toBeNull();
    expect(screen.queryByTestId('today-calendar')).toBeNull();
  });

  it('v6 §3.4: an empty today — the nearest day reads only (no «Календарь ›»); the card opens «День» on its leaf', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(14);
    const tomorrow = addDaysIso(isoDate(Date.now()), 1);
    useTasks.getState().set({ tasks: { n1: task({ id: 'n1', title: 'Забрать посылку', due_date: tomorrow }) } });
    calState().set({ view: 'month' });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('today-nearest') !== null);
    expect(screen.getByTestId('today-nearest')).toHaveTextContent(/Забрать посылку/);
    expect(screen.queryByTestId('today-calendar')).toBeNull();
    expect(screen.queryByTestId('today-plan')).toBeNull();
    await fireEvent.press(screen.getByTestId('today-next'));
    await settle(() => r.getPathname() === `/page/${tasksPage().id}`);
    expect(calState()).toMatchObject({ view: 'day', date: null });
    await settle(() => screen.queryByTestId('cal-screen') !== null);
  });

  it('v6 §4.4: «Все дела ›» opens «Дела» as the list, whatever view was last', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(14);
    const today = isoDate(Date.now());
    useTasks.getState().set({ tasks: { f1: task({ id: 'f1', title: 'Купить корм', due_date: today }) } });
    calState().set({ view: 'month' });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('today-all-tasks') !== null);
    await fireEvent.press(screen.getByTestId('today-all-tasks'));
    await settle(() => r.getPathname() === `/page/${tasksPage().id}`);
    expect(calState().view).toBe('list');
    await settle(() => screen.queryByTestId('page-add') !== null);
  });

  it('§14.2: the list view of «Дела» has the one arrow «‹» without words, back to «Сегодня»', async () => {
    resetApp();
    finishOnboarding('full');
    calState().set({ view: 'list' });
    const r = await renderRouter(APP_DIR, { initialUrl: `/page/${tasksPage().id}` });
    await settle(() => screen.queryByTestId('page-back') !== null);
    const back = screen.getByTestId('page-back');
    expect(back.props.accessibilityLabel).toBe('Назад, Сегодня');
    expect(back).not.toHaveTextContent(/Сегодня/);
    await fireEvent.press(back);
    await settle(() => r.getPathname() === '/');
  });
});

describe('changes by hand go through the outbox with their undo (calendar.md)', () => {
  const entryOf = (o: Partial<CalEntry>) => ({
    key: taskEntryKey('s1', null), kind: 'task' as const, id: 's1', occurrenceAt: null, title: 'Встреча', date: DAY, allDay: false,
    start: 600, duration: 60, startMs: at(600), rrule: null, done: false, source: null, itemId: null, changedAt: null, changedBy: null,
    plan: null, pending: false, version: 1, remind: null, ...o,
  });

  it('a move shows at once, queues `calendar.patch`, and «Вернуть» before it went drops it', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    useTasks.getState().set({ tasks: { s1: task({ id: 's1', start_at: new Date(at(600)).toISOString(), duration_min: 60 }) } });
    const rowId = await moveEntry(entryOf({}), { date: DAY, start: 660, duration: 90 });
    expect(calState().timeEdits[taskEntryKey('s1', null)]).toMatchObject({ startMs: at(660), duration: 90 });
    const row = (await outbox.get(rowId!))!;
    expect(row.kind).toBe('calendar.patch');
    expect((row.payload as { body: Record<string, unknown> }).body).toMatchObject({ duration_min: 90, start_at: isoWithOffset(at(660)) });
    const strip = useUndo.getState().strip;
    expect(strip?.kind === 'custom' ? [strip.text, strip.undoLabel] : null).toEqual(['Встреча: 10:00 → 11:00', 'Вернуть']);
    if (strip?.kind === 'custom') strip.onUndo();
    await settle(() => calState().timeEdits[taskEntryKey('s1', null)] === undefined);
    expect((await outbox.get(rowId!))!.status).toBe('failed');
  });

  it('an occurrence: done and «Это и следующие» carry `occurrence_at` and `scope`', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    const occ = new Date(at(540)).toISOString();
    const e = entryOf({ key: taskEntryKey('s1', at(540)), occurrenceAt: occ, rrule: 'FREQ=DAILY' });
    await setEntryDone(e, true);
    expect(calState().occEdits[e.key]).toMatchObject({ done: true });
    await deleteEntry(e, 'following');
    expect(calState().seriesEnds.s1?.from).toBe(at(540));
    const rows = await outbox.listPending(50);
    expect(rows.map((r) => r.kind)).toEqual(['calendar.done', 'calendar.delete']);
    expect(rows[1]!.payload).toMatchObject({ occurrenceAt: occ, scope: 'following' });
  });

  it('/sync occurrences settle the person\'s change once the server has it', async () => {
    resetApp();
    const ms = at(540, '2026-11-21');
    calState().set({ occEdits: { [taskEntryKey('run', ms)]: { done: true, clientId: 'c' } } });
    calendarSink.occurrences([occOut('o9', 4, { occurrence_at: new Date(ms).toISOString(), done_at: '2026-11-21T05:00:00Z' })]);
    expect(calState().occEdits).toEqual({});
    expect(calState().occurrences.o9?.seq).toBe(4);
    calendarSink.tombstone('o9');
    expect(calState().occurrences.o9).toBeUndefined();
  });
});
