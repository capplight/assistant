import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { looksLikeReminder, phoneIn } from '@/alarms/format';
import { levelFor, planAlarms, upcoming, type PlanInput } from '@/alarms/plan';
import { clampSnoozeMinutes, FakeAlarms, snoozeUntilFor, type AlarmCapabilities } from '@/alarms/port';
import { drain, refresh, replan, saveReminder, startTest } from '@/alarms/service';
import { alarmRisk, allDone, deviceCapabilities, setupSteps, s15AfterPhone } from '@/alarms/setup';
import { useAlarms } from '@/alarms/store';
import { fireOut, parseOut, reminderOut } from '@/api/endpoints';
import type { FireOut, ReminderOut } from '@/api/types';
import type { InMemoryOutboxRepository } from '@/db';
import { getSyncEngine } from '@/services';
import { fixInvalid, type QueuedReminderEvent } from '@/sync/engine';
import { happyServer, type FakeServer } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testAlarms } from '@/testing/helpers';

/**
 * Week 8 (F-11, US-9, R-09…R-13; docs/api/reminders.md 2026-11-08): planning local rings from the
 * server's fires, repeats, «Сделано» / «Отложить», events, S13 offline, S15, S04, the line.
 * JS only: the native module is replaced by FakeAlarms. Nothing here proves a phone rings.
 */

const MIN = 60_000;
const NOW = Date.parse('2026-11-08T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function reminder(id: string, extra: Partial<ReminderOut> = {}): ReminderOut {
  return reminderOut({
    id,
    client_id: `c-${id}`,
    title: 'Выпить таблетку',
    due_at: iso(NOW + 60 * MIN),
    tz: 'Asia/Almaty',
    offsets: [],
    level: 'alarm',
    kind: 'normal',
    status: 'scheduled',
    version: 1,
    seq: 1,
    ...extra,
  })!;
}

function fire(r: ReminderOut, extra: Partial<FireOut> = {}): FireOut {
  const offset = extra.offset_min ?? 0;
  const snooze = extra.snooze_n ?? 0;
  const fireAt = extra.fire_at ?? iso(Date.parse(r.due_at) - offset * MIN);
  return fireOut({
    id: `f-${r.id}-${offset}-${snooze}`,
    reminder_id: r.id,
    key: `${r.id}:${r.due_at}:${offset}:${snooze}`,
    occurrence_at: r.due_at,
    fire_at: fireAt,
    offset_min: offset,
    snooze_n: snooze,
    repeat_n: 0,
    state: 'planned',
    target_device_id: null,
    seq: 2,
    ...extra,
  })!;
}

function input(rs: ReminderOut[], fs: FireOut[], extra: Partial<PlanInput> = {}): PlanInput {
  return {
    reminders: Object.fromEntries(rs.map((r) => [r.id, r])),
    fires: Object.fromEntries(fs.map((f) => [f.key, f])),
    local: {},
    deviceId: 'd-1',
    now: NOW,
    backend: 'android',
    ...extra,
  };
}

describe('planner (pure)', () => {
  it('«Будильник» rings at the time and repeats +5/+10/+15; «Уведомление» once', () => {
    const a = reminder('r1');
    const n = reminder('r2', { level: 'notification' });
    const specs = planAlarms(input([a, n], [fire(a), fire(n)]));
    const ofA = specs.filter((s) => s.group === fire(a).key);
    expect(ofA.map((s) => (s.fireAt - Date.parse(a.due_at)) / MIN)).toEqual([0, 5, 10, 15]);
    expect(ofA.map((s) => s.repeatN)).toEqual([0, 1, 2, 3]);
    expect(ofA.every((s) => s.level === 'alarm' && s.dueAt === Date.parse(a.due_at))).toBe(true);
    expect(specs.filter((s) => s.group === fire(n).key)).toHaveLength(1);
  });

  it('another phone is the one that rings (R-13): here only a notification', () => {
    const a = reminder('r1');
    expect(levelFor(a, fire(a, { target_device_id: 'd-other' }), 'd-1')).toBe('notification');
    expect(levelFor(a, fire(a, { target_device_id: 'd-1' }), 'd-1')).toBe('alarm');
    expect(levelFor(a, fire(a, { target_device_id: null }), 'd-1')).toBe('alarm');
  });

  it('acked, missed, cancelled, deleted, answered here: nothing rings; past main ring keeps its future repeats', () => {
    const a = reminder('r1');
    const gone = reminder('r3', { deleted_at: iso(NOW), status: 'cancelled' });
    const states = (['acked', 'missed', 'cancelled'] as const).map((state, i) => fire(reminder(`s${i}`), { state }));
    const rs = [a, gone, ...states.map((f) => reminder(f.reminder_id))];
    expect(planAlarms(input(rs, [...states, fire(gone)]))).toEqual([]);
    expect(planAlarms(input([a], [fire(a)], { local: { [fire(a).key]: { ackedAt: NOW } } }))).toEqual([]);
    const later = planAlarms(input([a], [fire(a)], { now: Date.parse(a.due_at) + 6 * MIN }));
    expect(later.map((s) => s.repeatN)).toEqual([2, 3]);
  });

  it('«Отложить» here: rings again from the chosen time until the server sends the next fire, then that one at the chosen time', () => {
    const a = reminder('r1');
    const f0 = fire(a, { state: 'fired' });
    const until = Date.parse(a.due_at) + 30 * MIN;
    const local = { [f0.key]: { firedAt: NOW, snoozedUntil: until } };
    const before = planAlarms(input([a], [f0], { local, now: Date.parse(a.due_at) + MIN }));
    expect(before[0]).toMatchObject({ id: `${f0.key}~s${until.toString(36)}~0`, fireAt: until, group: f0.key });
    expect(before).toHaveLength(4);
    // The server's new fire is at +10 min (it does not know «Другое время»): the phone keeps +30.
    const f1 = fire(a, { snooze_n: 1, fire_at: iso(Date.parse(a.due_at) + 11 * MIN) });
    const after = planAlarms(input([a], [{ ...f0, state: 'snoozed' }, f1], { local, now: Date.parse(a.due_at) + MIN }));
    expect(after.every((s) => s.group === f1.key)).toBe(true);
    expect(after[0]!.fireAt).toBe(until);
  });

  it('iOS keeps at most 48 rings, Android 200', () => {
    const rs = Array.from({ length: 30 }, (_, i) => reminder(`m${i}`, { due_at: iso(NOW + (i + 1) * 60 * MIN) }));
    const fs = rs.map((r) => fire(r));
    expect(planAlarms(input(rs, fs, { backend: 'alarmkit' }))).toHaveLength(48);
    expect(planAlarms(input(rs, fs, { backend: 'android' }))).toHaveLength(120);
  });

  it('upcoming: one row per fire, test reminders hidden', () => {
    const a = reminder('r1');
    const test = reminder('t1', { kind: 'test' });
    const list = upcoming(input([a, test], [fire(a), fire(test)]), 24 * 60 * MIN);
    expect(list.map((s) => s.group)).toEqual([fire(a).key]);
  });
});

describe('S15 steps (pure)', () => {
  const android = (c: Partial<AlarmCapabilities> = {}): AlarmCapabilities => ({ ...new FakeAlarms().caps, ...c });
  const none = { autostartConfirmedAt: null, batteryConfirmedAt: null };

  it('Xiaomi, Android 14: notifications, exact alarms, full screen, autostart (by hand), battery (by hand)', () => {
    const steps = setupSteps(android({ notifications: 'granted', exactAlarms: false }), none);
    expect(steps.map((s) => [s.key, s.done, s.confirmByHand])).toEqual([
      ['notifications', true, false],
      ['exact', false, false],
      ['full_screen', true, false],
      ['autostart', false, true],
      ['battery', false, true],
    ]);
    expect(alarmRisk(android(), none)).toBe(true);
    const marks = { autostartConfirmedAt: 'x', batteryConfirmedAt: 'x' };
    expect(allDone(android({ notifications: 'granted' }), marks)).toBe(true);
    expect(alarmRisk(android({ notifications: 'granted' }), marks)).toBe(false);
  });

  it('Samsung: the system tells whether the app is unrestricted; no autostart step', () => {
    const c = android({ vendor: 'samsung', autostartStep: false, batteryUnrestricted: true, notifications: 'granted' });
    expect(setupSteps(c, none).map((s) => s.key)).toEqual(['notifications', 'exact', 'full_screen', 'battery']);
    expect(allDone(c, none)).toBe(true);
  });

  it('iPhone: AlarmKit step on iOS 26+, only notifications below; Expo Go on Android is always a risk', () => {
    const ios: AlarmCapabilities = { ...android(), platform: 'ios', backend: 'alarmkit', osVersion: 26, vendor: 'apple', exactAlarms: null, fullScreen: null, batteryUnrestricted: null, autostartStep: false, alarmKit: 'notDetermined', notifications: 'granted' };
    expect(setupSteps(ios, none).map((s) => s.key)).toEqual(['notifications', 'alarmkit']);
    expect(setupSteps({ ...ios, backend: 'notifications', alarmKit: null }, none).map((s) => s.key)).toEqual(['notifications']);
    expect(alarmRisk({ ...android({ notifications: 'granted' }), backend: 'notifications' }, none)).toBe(true);
    expect(s15AfterPhone(ios)).toBe(false);
    expect(s15AfterPhone(android())).toBe(true);
    expect(deviceCapabilities(android({ exactAlarms: false }), none)).toMatchObject({ exact_alarm_granted: false, s15_done: false, alarm_backend: 'android' });
  });

  it('phrases and phone numbers', () => {
    expect(looksLikeReminder('Напомни завтра в 7 выпить таблетку')).toBe(true);
    expect(looksLikeReminder('разбуди в 6')).toBe(true);
    expect(looksLikeReminder('Ертең 9-да еске сал')).toBe(false);
    expect(looksLikeReminder('еске сал ертең')).toBe(true);
    expect(looksLikeReminder('купить хлеб')).toBe(false);
    expect(phoneIn('Позвонить Ерлану +7 701 123 45 67')).toBe('+7 701 123 45 67');
  });
});

describe('snooze limits (reminders.md: until within at + 1 min … at + snooze_max_hours)', () => {
  it('«Другое время» is kept between 1 minute and the limit', () => {
    expect(clampSnoozeMinutes(30)).toBe(30);
    expect(clampSnoozeMinutes(0)).toBe(1);
    expect(clampSnoozeMinutes(3 * 24 * 60)).toBe(48 * 60);
    expect(clampSnoozeMinutes(5 * 60, 4)).toBe(4 * 60);
    expect(clampSnoozeMinutes(Number.NaN)).toBe(10);
  });

  it('`until` always has an offset and is counted from the event `at`, not from now', () => {
    const at = Date.parse('2026-11-08T10:00:00Z');
    expect(snoozeUntilFor(at, at + 30 * MIN)).toBe('2026-11-08T10:30:00.000Z');
    expect(snoozeUntilFor(at, at + 10_000)).toBe('2026-11-08T10:01:00.000Z');
    expect(snoozeUntilFor(at, at + 72 * 60 * MIN)).toBe('2026-11-10T10:00:00.000Z');
    expect(snoozeUntilFor(at, undefined)).toBeNull();
    expect(snoozeUntilFor(at, at + 72 * 60 * MIN, 24)).toBe('2026-11-09T10:00:00.000Z');
  });

  it('an `invalid` snooze is resent once without `until`, with a new client_id; never again after that', () => {
    const ev: QueuedReminderEvent = { client_id: 'c1', fire_id: 'f1', fire_key: 'k', event: 'snoozed', at: iso(NOW), meta: { until: iso(NOW + 30 * MIN), minutes: 30 } };
    const fixed = fixInvalid(ev)!;
    expect(fixed.client_id).not.toBe('c1');
    expect(fixed.retry_of).toBe('c1');
    expect(fixed.meta).toEqual({ minutes: 30, until_refused: iso(NOW + 30 * MIN) });
    expect(fixInvalid(fixed)).toBeNull();
    expect(fixInvalid({ ...ev, event: 'acked', meta: {} })).toBeNull();
  });
});

describe('decoders', () => {
  it('fire key falls back to the documented form; unknown state → planned; parse status other than ok/ambiguous → form', () => {
    const f = fireOut({ id: 'f', reminder_id: 'r', fire_at: '2026-11-09T01:00:00+00:00', occurrence_at: 'o', offset_min: 60, state: 'weird' })!;
    expect(f.key).toBe('r:o:60:0');
    expect(f.state).toBe('planned');
    expect(parseOut({ status: 'nope', reason: 'no_ai', message: 'Укажите время вручную.' })).toMatchObject({ status: 'form', reason: 'no_ai' });
    expect(reminderOut({ id: 'x' })).toBeNull();
  });
});

// --- with the sync engine and a fake server ---

type Srv = FakeServer & { reminders: ReminderOut[]; fires: FireOut[]; events: unknown[] };

function reminderServer(): Srv {
  const s = happyServer() as Srv;
  s.reminders = [];
  s.fires = [];
  s.events = [];
  let seq = 5000;
  s.on('POST /reminders/active', () => ({ status: 200, body: { device_id: 'd-1', retargeted: 0 } }))
    .on('GET /reminders/settings', () => ({ status: 200, body: { parser: 'llm', snooze_minutes: 10, repeat_minutes: [5, 10, 15], horizon_days: 14 } }))
    .on('GET /reminders/fires', () => ({ status: 200, body: { device_id: 'd-1', fires: s.fires, reminders: s.reminders } }))
    .on('POST /reminders/events', (c) => {
      const evs = (c.body as { events: { client_id: string }[] }).events;
      s.events.push(...evs);
      return { status: 200, body: { results: evs.map((e) => ({ client_id: e.client_id, status: 'applied' })), fires: [] } };
    })
    .on('POST /reminders', (c) => {
      const b = c.body as { client_id: string; title: string; due_at: string; offsets: number[]; level: 'alarm' | 'notification' };
      const r = reminder(`srv-${b.client_id}`, { client_id: b.client_id, title: b.title, due_at: b.due_at, offsets: b.offsets, level: b.level, seq: ++seq });
      const fs = [0, ...b.offsets].map((o) => fire(r, { offset_min: o, seq: ++seq }));
      s.reminders.push(r);
      s.fires.push(...fs);
      return { status: 201, body: { reminder: r, fires: fs } };
    })
    .on('POST /reminders/test', () => {
      const r = reminder('test-1', { kind: 'test', title: 'Проверка будильника', due_at: iso(Date.now() + MIN) });
      return { status: 201, body: { reminder: r, fires: [fire(r, { target_device_id: 'd-1' })] } };
    });
  return s;
}

async function online(s: Srv, mode: 'full' | 'no_ai' = 'full'): Promise<InMemoryOutboxRepository> {
  const outbox = resetApp({ fetch: s.fetch });
  finishOnboarding(mode);
  await (await getSyncEngine()).run();
  return outbox;
}

const flush = async () => {
  for (let i = 0; i < 3; i++) {
    await replan();
    await (await getSyncEngine()).run();
  }
};

const sent = (s: Srv, event: string) => (s.events as { event: string; fire_id: string; meta?: Record<string, unknown> }[]).filter((e) => e.event === event);

describe('reminders on the phone (FakeAlarms + fake server)', () => {
  it('fires from the window are planned, `scheduled_local` goes once with the scheduler', async () => {
    const s = reminderServer();
    const r = reminder('r1', { due_at: iso(Date.now() + 60 * MIN) });
    s.reminders.push(r);
    s.fires.push(fire(r));
    await online(s);
    await refresh();
    await flush();
    expect(testAlarms.planned.map((p) => p.id)).toEqual([0, 1, 2, 3].map((n) => `${fire(r).key}~${n}`));
    expect(sent(s, 'scheduled_local')).toEqual([expect.objectContaining({ fire_id: fire(r).id, meta: expect.objectContaining({ scheduler: 'alarm_clock' }) })]);
    await refresh();
    await flush();
    expect(sent(s, 'scheduled_local')).toHaveLength(1);
    expect(s.callsTo('POST /reminders/active')).toHaveLength(1); // ≤ 1/min
  });

  it('ring → `fired_local`; «Сделано» → `acked`, the repeats and the «за час» alert of the same occurrence go', async () => {
    const s = reminderServer();
    const r = reminder('r1', { due_at: iso(Date.now() + 120 * MIN), offsets: [60] });
    s.reminders.push(r);
    s.fires.push(fire(r), fire(r, { offset_min: 60 }));
    await online(s);
    await refresh();
    const early = fire(r, { offset_min: 60 });
    testAlarms.ring(`${early.key}~0`);
    await drain();
    testAlarms.press(early.key, 'done');
    await drain();
    await flush();
    expect(sent(s, 'fired_local')[0]).toMatchObject({ fire_id: early.id, meta: expect.objectContaining({ repeat_n: 0, fsi: true }) });
    expect(sent(s, 'acked')[0]).toMatchObject({ fire_id: early.id });
    expect(testAlarms.planned).toEqual([]);
  });

  it('«Отложить»: `snoozed` with the chosen time; rings again from it', async () => {
    const s = reminderServer();
    const r = reminder('r1', { due_at: iso(Date.now() + 30 * MIN) });
    s.reminders.push(r);
    s.fires.push(fire(r));
    await online(s);
    await refresh();
    testAlarms.ring(`${fire(r).key}~0`);
    testAlarms.press(fire(r).key, 'snooze', 30);
    await drain();
    await flush();
    const ev = sent(s, 'snoozed')[0]!;
    expect(ev.meta).toMatchObject({ minutes: 30 });
    const until = useAlarms.getState().local[fire(r).key]!.snoozedUntil!;
    expect(testAlarms.planned[0]).toMatchObject({ group: fire(r).key, fireAt: until });
    expect(testAlarms.planned).toHaveLength(4);
  });

  it('`snoozed` sends `until` within the settings limit; `invalid` keeps the local alarm and resends once without it', async () => {
    const s = reminderServer();
    s.on('GET /reminders/settings', () => ({ status: 200, body: { parser: 'llm', snooze_minutes: 10, snooze_max_hours: 2, repeat_minutes: [5, 10, 15], horizon_days: 14 } }));
    let refuse = 2;
    s.on('POST /reminders/events', (c) => {
      const evs = (c.body as { events: { client_id: string; event: string }[] }).events;
      s.events.push(...evs);
      return {
        status: 200,
        body: {
          results: evs.map((e) => ({ client_id: e.client_id, status: e.event === 'snoozed' && refuse-- > 0 ? 'invalid' : 'applied' })),
          fires: [],
        },
      };
    });
    const r = reminder('r1', { due_at: iso(Date.now() + 30 * MIN) });
    s.reminders.push(r);
    s.fires.push(fire(r));
    await online(s);
    await refresh();
    expect(useAlarms.getState().snoozeMaxHours).toBe(2);
    testAlarms.ring(`${fire(r).key}~0`);
    // The native side was asked for 5 h; the server allows 2 h: `until` goes clamped.
    testAlarms.press(fire(r).key, 'snooze', 5 * 60);
    await drain();
    await flush();
    await flush();
    const snoozes = sent(s, 'snoozed') as unknown as { client_id: string; at: string; meta: Record<string, unknown> }[];
    expect(snoozes).toHaveLength(2); // the first, then one fixed resend; no loop
    expect(Date.parse(snoozes[0]!.meta.until as string) - Date.parse(snoozes[0]!.at)).toBe(2 * 60 * MIN);
    expect(snoozes[0]!.meta.until).toMatch(/Z$/);
    expect(snoozes[1]!.meta.until).toBeUndefined();
    expect(snoozes[1]!.client_id).not.toBe(snoozes[0]!.client_id);
    // The person's alarm stays where they put it.
    const until = useAlarms.getState().local[fire(r).key]!.snoozedUntil!;
    expect(testAlarms.planned[0]).toMatchObject({ group: fire(r).key, fireAt: until });
  });

  it('S13 offline: rings at once from the phone; later POST /reminders, the server fires replace the local ones and old events find their fire', async () => {
    const s = reminderServer();
    const outbox = await online(s);
    s.offline = true;
    const due = Date.now() + 90 * MIN;
    await saveReminder({ title: 'Позвонить маме', dueAt: due, level: 'alarm', offsets: [] });
    expect(testAlarms.planned).toHaveLength(4);
    const localKey = testAlarms.planned[0]!.group;
    expect(localKey.startsWith('local:')).toBe(true);
    expect((await outbox.listPending()).map((e) => e.kind)).toContain('reminder.create');
    s.offline = false;
    await flush();
    expect(s.callsTo('POST /reminders')[0]!.body).toMatchObject({ title: 'Позвонить маме', level: 'alarm', created_via: 'manual_form', due_at: iso(due) });
    const serverKey = s.fires[0]!.key;
    expect(testAlarms.planned.every((p) => p.group === serverKey)).toBe(true);
    // The local scheduled_local, queued before the answer, reached the server with the real fire id.
    expect(sent(s, 'scheduled_local').map((e) => e.fire_id)).toContain(s.fires[0]!.id);
  });

  it('`/sync` arrays: a cancelled fire stops ringing; a reboot re-plans', async () => {
    const s = reminderServer();
    const r = reminder('r1', { due_at: iso(Date.now() + 60 * MIN) });
    s.reminders.push(r);
    s.fires.push(fire(r));
    await online(s);
    await refresh();
    expect(testAlarms.planned).toHaveLength(4);
    s.on('GET /sync', () => ({ status: 200, body: { items: [], reminders: [], reminder_fires: [fire(r, { state: 'cancelled', seq: 99 })], tombstones: [], next_since: 99, has_more: false } }));
    s.fires = [];
    await (await getSyncEngine()).run();
    await replan();
    expect(testAlarms.planned).toEqual([]);
    const calls = testAlarms.scheduleCalls;
    testAlarms.rebooted();
    await drain();
    await replan();
    expect(testAlarms.scheduleCalls).toBeGreaterThan(calls);
  });

  it('test alarm offline: local, nothing sent; a ring → «работает»', async () => {
    const s = reminderServer();
    await online(s);
    s.offline = true;
    await startTest();
    const t = useAlarms.getState().test;
    expect(t.state).toBe('waiting');
    const spec = testAlarms.planned[0]!;
    expect(spec.kind).toBe('test');
    testAlarms.ring(spec.id);
    await drain();
    expect(useAlarms.getState().test.state).toBe('ok');
    s.offline = false;
    await flush();
    expect(s.events).toEqual([]);
  });
});

describe('screens', () => {
  it('line offline: «Поставлю, когда появится интернет» [Поставить вручную] → S13 with the phrase; online again → «Проверьте напоминание»', async () => {
    const s = reminderServer();
    s.on('POST /reminders/parse', () => ({
      status: 200,
      body: { status: 'ok', source: 'llm', parser: 'llm', draft: { title: 'Выпить таблетку', due_at: iso(Date.now() + 20 * 60 * MIN), tz: 'Asia/Almaty', offsets: [], level: 'alarm' }, options: [] },
    }));
    await online(s);
    s.offline = true;
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Напомни завтра в 7 выпить таблетку');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => screen.queryByTestId('answer-set-by-hand') !== null);
    expect(screen.getByTestId('answer-notice')).toHaveTextContent('Поставлю, когда появится интернет.');
    expect(s.callsTo('POST /chat/messages')).toHaveLength(0);
    expect(useAlarms.getState().pendingPhrases).toHaveLength(1);
    s.offline = false;
    await act(async () => {
      await refresh();
    });
    await settle(() => screen.queryByTestId('reminder-draft') !== null);
    await fireEvent.press(screen.getByTestId('reminder-draft-open'));
    expect(r.getPathname()).toBe('/reminder-new');
    expect(screen.getByTestId('rem-title').props.value).toBe('Выпить таблетку');
  });

  it('«Без ИИ» online: the server says «Укажите время вручную» → S13 by hand; [Сохранить] rings and goes to the server; first reminder → S04', async () => {
    const s = reminderServer();
    s.on('POST /reminders/parse', () => ({ status: 200, body: { status: 'form', reason: 'no_ai', message: 'Укажите время вручную.', draft: null, options: [], parser: 'llm' } }));
    await online(s, 'no_ai');
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'напомни позвонить маме');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => r.getPathname() === '/reminder-new');
    expect(screen.getByTestId('rem-message')).toHaveTextContent('Укажите время вручную.');
    expect(screen.getByTestId('rem-title').props.value).toBe('напомни позвонить маме');
    await fireEvent.press(screen.getByTestId('rem-level-alarm'));
    await fireEvent.press(screen.getByTestId('rem-save'));
    await settle(() => r.getPathname() === '/notify');
    expect(testAlarms.planned.length).toBe(4);
    await fireEvent.press(screen.getByTestId('notify-allow'));
    await settle(() => r.getPathname() === '/');
    expect(testAlarms.caps.notifications).toBe('granted');
    await act(async () => {
      await flush();
    });
    expect(s.callsTo('POST /reminders')).toHaveLength(1);
  });

  it('S15 on a Xiaomi: [Открыть] goes to the system screen, ✓ on return; autostart by hand; «Позже» → banner on «Сегодня»', async () => {
    const s = reminderServer();
    await online(s);
    testAlarms.caps.exactAlarms = false;
    const r = await renderRouter(APP_DIR, { initialUrl: '/alarm-setup' });
    await settle(() => screen.queryByTestId('setup-open-exact') !== null);
    await fireEvent.press(screen.getByTestId('setup-open-exact'));
    expect(testAlarms.opened).toEqual(['exact']);
    testAlarms.caps.exactAlarms = true;
    await fireEvent.press(screen.getByTestId('setup-open-autostart'));
    await settle(() => screen.queryByTestId('setup-done-exact') !== null);
    await fireEvent.press(screen.getByTestId('setup-confirm-autostart'));
    await settle(() => screen.queryByTestId('setup-done-autostart') !== null);
    await fireEvent.press(screen.getByTestId('setup-later'));
    expect(r.getPathname()).toBe('/');
    await settle(() => screen.queryByTestId('alarm-risk') !== null);
    await fireEvent.press(screen.getByTestId('alarm-risk-fix'));
    expect(r.getPathname()).toBe('/alarm-setup');
  });

  it('S14 in the app: «Сделано» stops it and tells the server', async () => {
    const s = reminderServer();
    const rem = reminder('r1', { due_at: iso(Date.now() + 2 * MIN), title: 'Позвонить +7 701 123 45 67' });
    s.reminders.push(rem);
    s.fires.push(fire(rem));
    await online(s);
    await refresh();
    const r = await renderRouter(APP_DIR, { initialUrl: `/alarm?group=${encodeURIComponent(fire(rem).key)}` });
    expect(screen.getByTestId('alarm-title')).toHaveTextContent('Позвонить +7 701 123 45 67');
    expect(screen.getByTestId('alarm-call')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('alarm-done'));
    await settle(() => r.getPathname() === '/');
    await act(async () => {
      await flush();
    });
    expect(sent(s, 'acked')[0]).toMatchObject({ fire_id: fire(rem).id });
    expect(testAlarms.planned).toEqual([]);
  });
});
