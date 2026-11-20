import { fireEvent as press, render } from '@testing-library/react-native';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import type { TaskOut } from '@/api/types';
import { buildEntries, taskEntryKey, type CalEntry, type EntrySources } from '@/calendar/entries';
import { setReminderOffset, settleTimeEdits } from '@/calendar/service';
import { calState } from '@/calendar/store';
import { addDaysIso, atMinutes, isoDate } from '@/calendar/time';
import { EntrySheet } from '@/components/calendar/Sheets';
import { usePages } from '@/store/pages';
import { useTasks } from '@/tasks/store';
import { happyServer } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';

/** calendar.md «Reminder of a to-do»: «за 10 мин · за 30 мин · за час · за день · нет» in A4 and the card (A5). */

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
const tasksPage = () => usePages.getState().pages.find((p) => p.templateKey === 'tasks')!;
const bodyOf = (row: { payload: unknown }) => (row.payload as { body: Record<string, unknown> }).body;
const noop = () => undefined;

describe('«Напомнить» of a to-do', () => {
  it('A4: «за 10 мин» by default, the chips change it, POST /tasks carries `reminder_offset_min`; no time — no chips', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    calState().set({ view: 'day' });
    await renderRouter(APP_DIR, { initialUrl: `/page/${tasksPage().id}` });
    await settle(() => screen.queryByTestId('cal-screen') !== null);
    await fireEvent.press(screen.getAllByLabelText('22:00, свободно. Добавить')[0]!);
    await settle(() => screen.queryByTestId('cal-add') !== null);
    expect(screen.getByTestId('cal-add-remind')).toHaveTextContent('за 10 мин');
    expect(screen.queryByTestId('cal-add-remind-chips')).toBeNull();
    await fireEvent.press(screen.getByTestId('cal-add-remind'));
    for (const id of ['10', '30', '60', '1440', 'none']) expect(screen.getByTestId(`cal-add-remind-chips-${id}`)).toBeTruthy();
    expect(screen.getByTestId('cal-add-remind-chips')).toHaveTextContent(/за 10 мин.*за 30 мин.*за час.*за день.*нет/);
    expect(screen.getByTestId('cal-add-remind-chips-10').props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent.press(screen.getByTestId('cal-add-remind-chips-60'));
    expect(screen.queryByTestId('cal-add-remind-chips')).toBeNull();
    expect(screen.getByTestId('cal-add-remind')).toHaveTextContent('за час');
    await fireEvent.changeText(screen.getByTestId('cal-add-title'), 'Созвон');
    await fireEvent.press(screen.getByTestId('cal-add-save'));
    await settle(() => Object.values(useTasks.getState().tasks).some((x) => x.title === 'Созвон'));
    expect(Object.values(useTasks.getState().tasks).find((x) => x.title === 'Созвон')!.reminder_offset_min).toBe(60);
    await settle(() => false, 20).catch(() => undefined);
    const row = (await outbox.listPending(50)).find((r) => r.kind === 'task.create')!;
    expect(bodyOf(row)).toMatchObject({ title: 'Созвон', reminder_offset_min: 60 });

    // «Без времени»: nothing to choose, nothing sent.
    await fireEvent.press(screen.getAllByLabelText('20:00, свободно. Добавить')[0]!);
    await settle(() => screen.queryByTestId('cal-add') !== null);
    await fireEvent.press(screen.getByTestId('cal-add-more'));
    await fireEvent.press(screen.getByTestId('cal-add-untimed'));
    expect(screen.queryByTestId('cal-add-remind')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('cal-add-title'), 'Подарок');
    await fireEvent.press(screen.getByTestId('cal-add-save'));
    await settle(() => Object.values(useTasks.getState().tasks).some((x) => x.title === 'Подарок'));
    await settle(() => false, 20).catch(() => undefined);
    const plain = (await outbox.listPending(50)).find((r) => r.kind === 'task.create' && bodyOf(r).title === 'Подарок')!;
    expect(bodyOf(plain)).not.toHaveProperty('reminder_offset_min');
  });

  it('A5: the card shows the value; a chip PATCHes `reminder_offset_min` alone, shown at once, settled by the answer', async () => {
    const today = isoDate(Date.now());
    const startIso = new Date(atMinutes(today, 23 * 60)).toISOString();
    const s = happyServer();
    s.on('PATCH /tasks/m1', (c) => ({
      status: 200,
      body: {
        task: task({
          id: 'm1',
          title: 'Встреча',
          start_at: startIso,
          duration_min: 30,
          due_date: today,
          reminder_offset_min: (c.body as { reminder_offset_min: number | null }).reminder_offset_min,
          version: 2,
          seq: 5,
        }),
        action: null,
      },
    }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    useTasks.getState().set({ tasks: { m1: task({ id: 'm1', title: 'Встреча', start_at: startIso, duration_min: 30, due_date: today, reminder_offset_min: 10 }) } });
    calState().set({ view: 'day' });
    await renderRouter(APP_DIR, { initialUrl: `/page/${tasksPage().id}` });
    await settle(() => screen.queryByTestId('cal-screen') !== null);
    const key = taskEntryKey('m1', null);
    await settle(() => screen.queryByTestId(`cal-block-${key}`) !== null);
    await fireEvent.press(screen.getByTestId(`cal-block-${key}`));
    await settle(() => screen.queryByTestId('cal-card') !== null);
    expect(screen.getByTestId('cal-card-remind')).toHaveTextContent(/Напомнить.*за 10 мин/);
    await fireEvent.press(screen.getByTestId('cal-card-remind'));
    expect(screen.getByTestId('cal-card-remind-chips-10').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.queryByTestId('cal-card-remind-chips-series')).toBeNull();
    await fireEvent.press(screen.getByTestId('cal-card-remind-chips-1440'));
    expect(screen.getByTestId('cal-card-remind')).toHaveTextContent(/за день/);
    await settle(() => s.callsTo('PATCH /tasks/m1').length === 1);
    expect(s.callsTo('PATCH /tasks/m1')[0]!.body).toEqual({ version: 1, client_id: expect.any(String), reminder_offset_min: 1440 });
    await settle(() => calState().remindEdits.m1 === undefined && useTasks.getState().tasks.m1?.reminder_offset_min === 1440);
  });

  it('offline: an occurrence changes the series (no `occurrence_at` / `scope`), «нет» = null; all-day has none; /sync settles', async () => {
    const outbox = resetApp();
    finishOnboarding('full');
    const start = new Date(at(540)).toISOString();
    useTasks.getState().set({
      tasks: { s1: task({ id: 's1', start_at: start, duration_min: 60, rrule: 'FREQ=DAILY', reminder_offset_min: 30 }), d1: task({ id: 'd1', due_date: DAY }) },
    });
    const entries = () => buildEntries(src({ tasks: useTasks.getState().tasks, remindEdits: calState().remindEdits }), DAY, addDaysIso(DAY, 1));
    const occ = entries().find((e) => e.id === 's1')!;
    expect(occ.occurrenceAt).not.toBeNull();
    expect(occ.offset).toBe(30);
    const rowId = await setReminderOffset(occ, null);
    const row = (await outbox.get(rowId!))!;
    expect(row.kind).toBe('calendar.patch');
    expect(bodyOf(row)).toEqual({ reminder_offset_min: null });
    expect(entries().filter((e) => e.id === 's1').map((e) => e.offset)).toEqual([null, null]);
    expect(await setReminderOffset(occ, null)).toBeNull();
    expect(await setReminderOffset(entries().find((e) => e.id === 'd1')!, 10)).toBeNull();

    calState().set({ remindEdits: { s1: { offset: 60, clientId: 'c' } } });
    settleTimeEdits([task({ id: 's1', start_at: start, reminder_offset_min: 30 })]);
    expect(calState().remindEdits.s1).toBeDefined();
    settleTimeEdits([task({ id: 's1', start_at: start, reminder_offset_min: 60 })]);
    expect(calState().remindEdits.s1).toBeUndefined();
  });

  it('the card of an occurrence says it is the whole series\'; an all-day to-do\'s row does not open', async () => {
    resetApp();
    const entry: CalEntry = {
      key: taskEntryKey('s1', at(540)), kind: 'task', id: 's1', occurrenceAt: new Date(at(540)).toISOString(), title: 'Пробежка', date: DAY,
      allDay: false, start: 540, duration: 60, startMs: at(540), rrule: 'FREQ=DAILY', done: false, source: null, itemId: null, changedAt: null,
      changedBy: null, plan: null, pending: false, version: 1, remind: null, offset: 60,
    };
    const onRemind = jest.fn();
    const sheet = (e: CalEntry) => (
      <EntrySheet entry={e} onClose={noop} onRename={noop} onTime={noop} onRepeat={noop} onDone={noop} onDelete={noop} onRemind={onRemind} />
    );
    const r = await render(sheet(entry));
    expect(r.getByTestId('cal-card-remind')).toHaveTextContent(/за час/);
    await press.press(r.getByTestId('cal-card-remind'));
    expect(r.getByTestId('cal-card-remind-chips-series')).toHaveTextContent('Для всех повторов');
    await press.press(r.getByTestId('cal-card-remind-chips-60'));
    expect(onRemind).not.toHaveBeenCalled();
    await press.press(r.getByTestId('cal-card-remind'));
    await press.press(r.getByTestId('cal-card-remind-chips-none'));
    expect(onRemind).toHaveBeenCalledWith(null);
    r.unmount();
    const d = await render(sheet({ ...entry, occurrenceAt: null, rrule: null, allDay: true, start: null, duration: null, startMs: null, offset: null }));
    expect(d.getByTestId('cal-card-remind')).toHaveTextContent(/нет/);
    await press.press(d.getByTestId('cal-card-remind'));
    expect(d.queryByTestId('cal-card-remind-chips')).toBeNull();
  });
});
