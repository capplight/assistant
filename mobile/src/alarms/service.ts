import { ApiError, NetworkError } from '@/api/errors';
import type { DeviceOut, FireOut, ReminderCreateIn, ReminderOut, ReminderParseOut, ReminderWithFiresOut } from '@/api/types';
import { getOutbox } from '@/db';
import i18n from '@/i18n';
import type { QueuedReminderEvent, ReminderSink } from '@/sync/engine';
import { newId } from '@/utils/id';

import { planAlarms, type LocalFireState } from './plan';
import { clampSnoozeMinutes, snoozeUntilFor, type AlarmCapabilities, type AlarmEvent, type AlarmPort, type ScheduleResult } from './port';
import { deviceCapabilities } from './setup';
import { alarms, type ReadyDraft } from './store';

/**
 * The phone side of reminders (docs/api/reminders.md, 3-engineering 6.6):
 * server fires → `planAlarms` → the port (native module or notifications) → events from the port →
 * outbox `reminder.events`. Re-planned on start, foreground, every sync, every change here, after a
 * reboot / time change (the module says so), after S15. Works without the internet: what is on
 * the phone rings; S13 saves locally and the outbox sends it later.
 */
export type AlarmDeps = {
  port: () => AlarmPort;
  api: () => import('@/api/endpoints').Api;
  /** Consent given and nothing blocks the account: requests may go out. */
  canTalk: () => boolean;
  kickSync: () => void;
  /** `devices.capabilities` changed: the device row goes again. */
  deviceChanged: () => void;
  now?: () => number;
};

let deps: AlarmDeps | null = null;

export function configureAlarms(d: AlarmDeps): void {
  deps = d;
}

const now = () => deps?.now?.() ?? Date.now();
const MIN = 60_000;
const ACTIVE_EVERY_MS = MIN;
const LOCAL_PREFIX = 'local:';
const TEST_FAIL_AFTER_MS = 3 * MIN;

function d(): AlarmDeps {
  if (!deps) throw new Error('alarms not configured');
  return deps;
}

// --- the server's copy ---

function merge(reminders: ReminderOut[], fires: FireOut[], deviceId?: string | null): void {
  const s = alarms();
  const rs = { ...s.reminders };
  const fs = { ...s.fires };
  const local = { ...s.local };
  for (const r of reminders) {
    const prev = rs[r.id];
    if (!prev || prev.seq <= r.seq) rs[r.id] = r;
    // A local copy of the same reminder (saved offline) goes once the server one is here.
    if (r.client_id) delete rs[LOCAL_PREFIX + r.client_id];
  }
  const horizon = now() - 2 * 24 * 60 * MIN;
  for (const f of fires) {
    const prev = fs[f.key];
    if (!prev || prev.seq <= f.seq) fs[f.key] = f;
    // The server confirmed what the phone did: the local mark is not needed any more.
    if (f.state === 'acked' || f.state === 'cancelled' || f.state === 'missed') delete local[f.key];
  }
  // Old fires go: the window is the next 14 days.
  for (const [k, f] of Object.entries(fs)) {
    if (Date.parse(f.fire_at) < horizon) {
      delete fs[k];
      delete local[k];
    }
  }
  s.set({ reminders: rs, fires: fs, local, ...(deviceId ? { deviceId } : {}) });
}

/** The fires that came with POST /reminders replace the phone's own guess of them. */
function created(clientId: string, out: ReminderWithFiresOut): void {
  const s = alarms();
  const localId = LOCAL_PREFIX + clientId;
  const fires = { ...s.fires };
  const local = { ...s.local };
  const aliases: Record<string, string> = {};
  for (const [k, f] of Object.entries(fires)) {
    if (f.reminder_id !== localId) continue;
    const real = out.fires.find((g) => g.offset_min === f.offset_min && g.occurrence_at === f.occurrence_at);
    if (real) aliases[k] = real.key;
    if (local[k]) {
      if (real) local[real.key] = local[k]!;
      delete local[k];
    }
    delete fires[k];
  }
  const reminders = { ...s.reminders };
  delete reminders[localId];
  s.set({ fires, local, reminders, aliases: { ...s.aliases, ...aliases } });
  merge(out.reminder ? [out.reminder] : [], out.fires);
  void replan();
}

function createFailed(clientId: string): void {
  const s = alarms();
  const localId = LOCAL_PREFIX + clientId;
  const reminders = { ...s.reminders };
  const r = reminders[localId];
  if (r) reminders[localId] = { ...r, status: 'cancelled', deleted_at: new Date(now()).toISOString() };
  s.set({ reminders });
  void replan();
}

function fireId(key: string): string | null {
  const s = alarms();
  const real = s.fires[key] ?? s.fires[s.aliases[key] ?? ''];
  return real && !real.reminder_id.startsWith(LOCAL_PREFIX) ? real.id : null;
}

function localOnly(key: string): boolean {
  const s = alarms();
  if (s.aliases[key]) return false;
  const f = s.fires[key];
  if (!f) return key.startsWith(LOCAL_PREFIX) && !s.aliases[key];
  if (!f.reminder_id.startsWith(LOCAL_PREFIX)) return false;
  const r = s.reminders[f.reminder_id];
  return !r || r.kind === 'test' || r.status === 'cancelled';
}

export const reminderSink: ReminderSink = {
  applyServer: (r, f, deviceId) => {
    merge(r, f, deviceId);
    void replan();
  },
  created,
  createFailed: (clientId) => createFailed(clientId),
  fireId,
  serverKey: (key) => {
    const real = alarms().aliases[key] ?? key;
    return real.startsWith(LOCAL_PREFIX) ? null : real;
  },
  localOnly,
  /** PATCH /reminders/{id} answered («Перенести»): the phone's guess of the fires goes. */
  updated: (id, out) => {
    dropGuess(id);
    merge(out.reminder ? [out.reminder] : [], out.fires);
    void replan();
  },
  /** Refused (e.g. `409 conflict`): the guess goes, the server's copy comes with the next sync. */
  updateFailed: (id) => {
    dropGuess(id);
    void replan();
  },
  deviceRegistered: (device: DeviceOut) => {
    if (device.id && alarms().deviceId !== device.id) {
      alarms().set({ deviceId: device.id });
      void replan();
    }
  },
};

// --- capabilities ---

let lastSentCaps = '';

export async function refreshCaps(): Promise<AlarmCapabilities | null> {
  if (!deps) return null;
  try {
    const caps = await d().port().capabilities();
    alarms().set({ caps });
    const s = alarms();
    const json = JSON.stringify(deviceCapabilities(caps, s));
    if (lastSentCaps && json !== lastSentCaps) d().deviceChanged();
    lastSentCaps = json;
    return caps;
  } catch {
    return null;
  }
}

/** For POST /devices. */
export function currentDeviceCapabilities(): { capabilities: Record<string, unknown>; manufacturer?: string; model?: string } {
  const s = alarms();
  const c = s.caps;
  return {
    capabilities: deviceCapabilities(c, s),
    ...(c?.manufacturer ? { manufacturer: c.manufacturer } : {}),
    ...(c?.model ? { model: c.model } : {}),
  };
}

// --- planning ---

/** The native screens' texts, in the person's language (they also show while JS is not running). */
export function sendLabels(): void {
  if (!deps) return;
  const t = i18n.t.bind(i18n);
  d().port().setLabels({
    heading: t('alarm.heading'),
    done: t('alarm.done'),
    snooze: t('alarm.snooze'),
    snooze_short: t('alarm.snooze_short'),
    other_time: t('alarm.other_time'),
    in_5: t('alarm.in_5'),
    in_30: t('alarm.in_30'),
    in_60: t('alarm.in_60'),
    tomorrow: t('alarm.tomorrow'),
    call: t('alarm.call'),
    channel_alarms: t('alarm.channel_alarms'),
    channel_reminders: t('alarm.channel_reminders'),
    reminder: t('alarm.reminder'),
  });
}

let planning: Promise<void> | null = null;
let planAgain = false;

/** Single-flight: a call while planning plans once more afterwards. */
export function replan(): Promise<void> {
  if (!deps) return Promise.resolve();
  if (planning) {
    planAgain = true;
    return planning;
  }
  planning = (async () => {
    do {
      planAgain = false;
      await planOnce();
    } while (planAgain);
  })()
    .catch(() => undefined)
    .finally(() => {
      planning = null;
    });
  return planning;
}

async function planOnce(): Promise<void> {
  const caps = alarms().caps ?? (await refreshCaps());
  const s = alarms();
  const specs = planAlarms({
    reminders: s.reminders,
    fires: s.fires,
    local: s.local,
    deviceId: s.deviceId,
    now: now(),
    backend: caps?.backend ?? 'none',
  });
  let results: ScheduleResult[] = [];
  try {
    results = await d().port().schedule(specs);
  } catch {
    results = specs.map((x) => ({ id: x.id, scheduler: 'failed' as const, error: 'port' }));
  }
  // `scheduled_local` once per fire and scheduler (the main ring of the group stands for it).
  const reported = { ...alarms().reported };
  const out: QueuedReminderEvent[] = [];
  const at = new Date(now()).toISOString();
  for (const spec of specs) {
    if (spec.repeatN !== 0) continue;
    const r = results.find((x) => x.id === spec.id);
    if (!r) continue;
    const mark = `${r.scheduler}:${spec.fireAt}`;
    if (reported[spec.group] === mark) continue;
    reported[spec.group] = mark;
    out.push({
      client_id: newId(),
      fire_key: spec.group,
      fire_id: fireId(spec.group),
      event: r.scheduler === 'failed' ? 'schedule_failed' : 'scheduled_local',
      at,
      meta: {
        scheduler: r.scheduler === 'failed' ? undefined : r.scheduler,
        fsi: caps?.fullScreen ?? false,
        level: spec.level,
        ...(r.error ? { error: r.error } : {}),
      },
    });
  }
  for (const k of Object.keys(reported)) if (!specs.some((x) => x.group === k)) delete reported[k];
  alarms().set({ reported });
  await queueEvents(out);
}

async function queueEvents(events: QueuedReminderEvent[]): Promise<string | null> {
  const send = events.filter((e) => !localOnly(e.fire_key));
  if (send.length === 0) return null;
  const row = await (await getOutbox()).enqueue('reminder.events', { events: send });
  d().kickSync();
  return row.id;
}

// --- events from the port ---

const EVENT_FOR: Record<string, QueuedReminderEvent['event'] | null> = {
  fired: 'fired_local',
  shown: 'shown',
  acked: 'acked',
  snoozed: 'snoozed',
  dismissed: 'dismissed',
  rescheduled: null,
};

let draining: Promise<AlarmEvent[]> | null = null;

/** Reads what rang / was pressed, marks it here, queues it for the server. Returns the new events. */
export function drain(): Promise<AlarmEvent[]> {
  if (!deps) return Promise.resolve([]);
  if (!draining) {
    draining = drainOnce().finally(() => {
      draining = null;
    });
  }
  return draining;
}

async function drainOnce(): Promise<AlarmEvent[]> {
  let events: AlarmEvent[] = [];
  try {
    events = await d().port().drainEvents();
  } catch {
    return [];
  }
  if (events.length === 0) return [];
  const s = alarms();
  const seen = new Set(s.seen.map((x) => x.key));
  const local: Record<string, LocalFireState> = { ...s.local };
  const out: QueuedReminderEvent[] = [];
  const fresh: AlarmEvent[] = [];
  let rescheduled = false;
  for (const e of events.sort((a, b) => a.at - b.at)) {
    if (e.event === 'rescheduled') {
      rescheduled = true;
      continue;
    }
    // The same ring reported twice (tray + listener, native + fallback on iOS): once.
    const dedupe = `${e.alarmId ?? e.group}:${e.event}:${e.event === 'snoozed' ? e.until : ''}`;
    if (seen.has(dedupe)) continue;
    if (e.event === 'acked' && local[e.group]?.ackedAt) continue;
    seen.add(dedupe);
    fresh.push(e);
    const prev = local[e.group] ?? {};
    if (e.event === 'fired' || e.event === 'shown') local[e.group] = { ...prev, firedAt: prev.firedAt ?? e.at };
    if (e.event === 'acked') {
      local[e.group] = { ...prev, ackedAt: e.at, snoozedUntil: undefined };
      // «Сделано» answers the whole occurrence: the other alerts of it go too (reminders.md `acked`).
      const f = s.fires[e.group];
      if (f) {
        for (const g of Object.values(s.fires)) {
          if (g.reminder_id === f.reminder_id && g.occurrence_at === f.occurrence_at && g.key !== f.key) {
            local[g.key] = { ...(local[g.key] ?? {}), ackedAt: e.at };
          }
        }
      }
    }
    if (e.event === 'snoozed' && e.until) local[e.group] = { ...prev, snoozedUntil: e.until, ackedAt: undefined };
    const kind = EVENT_FOR[e.event];
    if (!kind || !e.group) continue;
    out.push({
      client_id: newId(),
      fire_key: e.group,
      fire_id: fireId(e.group),
      event: kind,
      at: new Date(e.at).toISOString(),
      meta: {
        repeat_n: e.repeatN ?? 0,
        ...(e.surface ? { surface: e.surface, fsi: e.surface === 'fsi' } : {}),
        ...(alarms().reported[e.group] ? { scheduler: alarms().reported[e.group]!.split(':')[0] } : {}),
        ...(e.delayMs !== undefined ? { delay_ms: e.delayMs } : {}),
        // The server makes the new fire at +10 min; «Другое время» chose this (reminders.md has no field yet).
        ...(e.event === 'snoozed' ? snoozeMeta(e) : {}),
      },
    });
  }
  const keep = [...s.seen, ...[...seen].filter((k) => !s.seen.some((x) => x.key === k)).map((key) => ({ key, at: now() }))]
    .filter((x) => x.at > now() - 3 * 24 * 60 * MIN)
    .slice(-500);
  alarms().set({ local, seen: keep });
  checkTest(fresh);
  await queueEvents(out);
  if (rescheduled || fresh.some((e) => e.event !== 'fired' && e.event !== 'shown')) void replan();
  return fresh;
}

/** `until` as the server accepts it (reminders.md): from the event's `at`, within 1 min … snooze_max_hours. */
function snoozeMeta(e: AlarmEvent): Record<string, unknown> {
  const until = snoozeUntilFor(e.at, e.until, alarms().snoozeMaxHours);
  return { ...(until ? { until } : {}), ...(e.minutes !== undefined ? { minutes: e.minutes } : {}) };
}

// --- the test alarm (S15) ---

function checkTest(events: AlarmEvent[]): void {
  const t = alarms().test;
  if (t.state !== 'waiting') return;
  const hit = events.find((e) => (e.event === 'fired' || e.event === 'shown') && (e.group === t.group || e.kind === 'test'));
  if (hit) {
    alarms().set({ test: { state: 'ok', at: hit.at, delayMs: hit.at - t.dueAt } });
    return;
  }
  // Answered without a ring report (e.g. AlarmKit «Сделано» while the app was closed): it rang.
  const answered = events.find((e) => (e.event === 'acked' || e.event === 'snoozed') && e.group === t.group);
  if (answered) alarms().set({ test: { state: 'ok', at: answered.at, delayMs: null } });
}

/** 3 minutes after the test time without a ring: «Не сработал». */
export function testTimedOut(): boolean {
  const t = alarms().test;
  if (t.state === 'waiting' && now() > t.dueAt + TEST_FAIL_AFTER_MS) {
    alarms().set({ test: { state: 'failed', at: now() } });
    return true;
  }
  return false;
}

/**
 * «Проверить будильник»: `POST /reminders/test` (rings in 1 minute on this phone, events and the
 * backup push as for any reminder). Offline or refused: the same test here only, nothing is sent.
 */
export async function startTest(): Promise<void> {
  const clientId = newId();
  const due = now() + MIN;
  alarms().set({ test: { state: 'waiting', group: null, reminderClientId: clientId, dueAt: due } });
  if (d().canTalk()) {
    try {
      const out = await d().api().reminderTest();
      const fire = out.fires[0];
      if (out.reminder && fire) {
        merge([out.reminder], out.fires);
        alarms().set({ test: { state: 'waiting', group: fire.key, reminderClientId: clientId, dueAt: Date.parse(fire.fire_at) } });
        await replan();
        return;
      }
    } catch {
      // offline / not available: test here
    }
  }
  const title = i18n.t('setup.test_title');
  const r = localReminder(clientId, { title, dueAt: due, level: 'alarm', kind: 'test', offsets: [] });
  const fs = localFires(r);
  const s = alarms();
  s.set({
    reminders: { ...s.reminders, [r.id]: r },
    fires: { ...s.fires, ...Object.fromEntries(fs.map((f) => [f.key, f])) },
    test: { state: 'waiting', group: fs[0]!.key, reminderClientId: clientId, dueAt: due },
  });
  await replan();
}

// --- S13: a reminder saved here ---

export type ReminderInput = {
  /** Week 9: the chat reply of the draft (`reminder_draft`), so «Что я сделал» links to the line. */
  messageId?: string | null;
  title: string;
  /** The event moment (ms). */
  dueAt: number;
  level: 'alarm' | 'notification';
  offsets: number[];
  createdVia?: ReminderCreateIn['created_via'];
  parseSource?: ReminderCreateIn['parse_source'];
  kind?: 'normal' | 'test';
};

function phoneTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Almaty';
  } catch {
    return 'Asia/Almaty';
  }
}

function localReminder(clientId: string, i: ReminderInput): ReminderOut {
  const iso = new Date(now()).toISOString();
  return {
    id: LOCAL_PREFIX + clientId,
    client_id: clientId,
    title: i.title,
    body: null,
    due_at: new Date(i.dueAt).toISOString(),
    tz: phoneTz(),
    local: null,
    rrule: null,
    offsets: i.offsets,
    level: i.level,
    kind: i.kind ?? 'normal',
    created_via: i.createdVia ?? 'manual_form',
    parse_source: i.parseSource ?? 'user_edit',
    sensitivity: null,
    status: 'scheduled',
    snooze_until: null,
    item_id: null,
    when_text: null,
    version: 0,
    seq: 0,
    created_at: iso,
    updated_at: iso,
    deleted_at: null,
  };
}

/** The phone's own guess of the fires (the event moment + each offset still in the future). */
function localFires(r: ReminderOut): FireOut[] {
  const due = Date.parse(r.due_at);
  return [0, ...r.offsets]
    .map((off) => ({ off, at: due - off * MIN }))
    .filter((x) => x.at > now())
    .map(({ off, at }) => ({
      id: '',
      reminder_id: r.id,
      key: `${r.id}:${r.due_at}:${off}:0`,
      occurrence_at: r.due_at,
      fire_at: new Date(at).toISOString(),
      offset_min: off,
      snooze_n: 0,
      repeat_n: 0,
      state: 'planned' as const,
      target_device_id: null,
      seq: 0,
      updated_at: r.updated_at,
    }));
}

/** Fires the phone made up for a changed reminder (no server id yet). */
function dropGuess(reminderId: string): void {
  const s = alarms();
  const fires = { ...s.fires };
  for (const [k, f] of Object.entries(fires)) if (f.reminder_id === reminderId && f.id === '') delete fires[k];
  s.set({ fires });
}

/** `reminder.update`: PATCH /reminders/{id} with the version the person saw. */
export type ReminderUpdatePayload = { id: string; body: import('@/api/types').ReminderPatchIn };

/**
 * «Перенести» (S13 opened from a missed row, today.md): the same reminder at a new time, PATCH
 * /reminders/{id}. Rings from the new time at once (offline too); the server re-plans its fires
 * and its answer replaces the phone's guess. A repeating reminder is not moved (its whole series
 * would move): the caller saves a new one-off instead.
 */
export async function moveReminder(id: string, i: Omit<ReminderInput, 'kind' | 'createdVia' | 'parseSource'>): Promise<ReminderOut | null> {
  const s = alarms();
  const r = s.reminders[id];
  if (!r || r.rrule || id.startsWith(LOCAL_PREFIX)) return null;
  const moved: ReminderOut = {
    ...r,
    title: i.title,
    due_at: new Date(i.dueAt).toISOString(),
    local: null,
    when_text: null,
    level: i.level,
    offsets: i.offsets,
    status: 'scheduled',
    parse_source: 'user_edit',
  };
  const fires = { ...s.fires };
  // The old future alerts of this reminder stop ringing here at once.
  for (const [k, f] of Object.entries(fires)) {
    if (f.reminder_id === id && f.state === 'planned' && Date.parse(f.fire_at) > now()) fires[k] = { ...f, state: 'cancelled' };
  }
  for (const f of localFires(moved)) fires[f.key] = f;
  s.set({ reminders: { ...s.reminders, [id]: moved }, fires });
  await replan();
  const payload: ReminderUpdatePayload = {
    id,
    body: { version: r.version, title: i.title, due_at: moved.due_at, level: i.level, offsets: i.offsets },
  };
  await (await getOutbox()).enqueue('reminder.update', payload);
  d().kickSync();
  return moved;
}

/**
 * [Сохранить] on S13: rings at once from here (also offline and in «Без ИИ»), the server gets it
 * through the outbox (`client_id` makes the retry safe).
 */
export async function saveReminder(i: ReminderInput): Promise<ReminderOut> {
  const clientId = newId();
  const r = localReminder(clientId, i);
  const s = alarms();
  s.set({
    reminders: { ...s.reminders, [r.id]: r },
    fires: { ...s.fires, ...Object.fromEntries(localFires(r).map((f) => [f.key, f])) },
  });
  await replan();
  const body: ReminderCreateIn = {
    client_id: clientId,
    title: i.title,
    due_at: r.due_at,
    tz: r.tz,
    offsets: i.offsets,
    level: i.level,
    created_via: r.created_via ?? 'manual_form',
    parse_source: r.parse_source,
    ...(i.messageId ? { message_id: i.messageId } : {}),
  };
  await (await getOutbox()).enqueue('reminder.create', { body });
  d().kickSync();
  return r;
}

// --- the buttons in the app (S14 in the app) ---

export async function act(group: string, action: 'done' | 'snooze', minutes = 10): Promise<void> {
  await d().port().act(group, action, action === 'snooze' ? clampSnoozeMinutes(minutes, alarms().snoozeMaxHours) : minutes);
  await drain();
}

// --- talking to the server ---

let refreshing: Promise<void> | null = null;

/**
 * Start, foreground, push: «this phone is active» (≤ 1/min), the settings, the planning window.
 * Then phrases that waited for the internet are parsed (→ «Проверьте напоминание»).
 */
export function refresh(): Promise<void> {
  if (!deps) return Promise.resolve();
  if (!refreshing) {
    refreshing = refreshOnce()
      .catch(() => undefined)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

async function refreshOnce(): Promise<void> {
  await refreshCaps();
  await drain();
  if (d().canTalk()) {
    const api = d().api();
    try {
      if (now() - alarms().lastActiveAt >= ACTIVE_EVERY_MS) {
        const a = await api.reminderActive();
        alarms().set({ lastActiveAt: now(), ...(a.device_id ? { deviceId: a.device_id } : {}) });
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'device_unknown') d().deviceChanged();
    }
    try {
      if (alarms().parser === null) {
        const st = await api.reminderSettings();
        alarms().set({ parser: st.parser, snoozeMaxHours: st.snooze_max_hours });
      }
    } catch {
      // the default (llm) holds
    }
    try {
      const w = await api.reminderFires();
      merge(w.reminders, w.fires, w.device_id);
    } catch {
      // offline: plan what is here
    }
    await parsePending();
  }
  testTimedOut();
  await replan();
}

// --- phrases (S13 «как понял») ---

/** Online: the server reads the phrase (its Ф-1 setting decides how). Throws NetworkError offline. */
export async function parsePhrase(text: string, createdVia: 'typed' | 'voice' = 'typed'): Promise<ReminderParseOut> {
  const out = await d().api().parseReminder({ text, created_via: createdVia, tz: phoneTz() });
  if (out.parser) alarms().set({ parser: out.parser });
  return out;
}

/** Offline: «Поставлю, когда появится интернет» — kept until it can be parsed. */
export function keepPhrase(text: string): void {
  const s = alarms();
  s.set({ pendingPhrases: [...s.pendingPhrases, { id: newId(), text, at: now() }] });
}

export function dropPhrase(id: string): void {
  const s = alarms();
  s.set({ pendingPhrases: s.pendingPhrases.filter((p) => p.id !== id), drafts: s.drafts.filter((x) => x.id !== id) });
}

async function parsePending(): Promise<void> {
  for (const p of alarms().pendingPhrases) {
    try {
      const out = await parsePhrase(p.text);
      const ready: ReadyDraft = {
        id: p.id,
        text: p.text,
        draft: out.draft ?? out.options[0] ?? null,
        message: out.status === 'form' ? out.message : null,
        options: out.options,
      };
      const s = alarms();
      s.set({ pendingPhrases: s.pendingPhrases.filter((x) => x.id !== p.id), drafts: [...s.drafts, ready] });
    } catch (e) {
      if (e instanceof NetworkError) return;
      // refused: it stays a phrase the person can set by hand
      const s = alarms();
      s.set({
        pendingPhrases: s.pendingPhrases.filter((x) => x.id !== p.id),
        drafts: [...s.drafts, { id: p.id, text: p.text, draft: null, message: null, options: [] }],
      });
    }
  }
}

/** Test hook. */
export function resetAlarmsForTests(): void {
  deps = null;
  lastSentCaps = '';
  planning = null;
  planAgain = false;
  draining = null;
  refreshing = null;
}

// --- week 9: «Пропущено» on «Сегодня» and «Дела» ---

/** «Пропущено» shows at +30 min (reminders.md `missed_at`); the server's `missed` comes with sync. */
export const MISSED_AFTER_MS = 30 * MIN;

export type MissedRow = { key: string; reminderId: string; title: string; at: number; level: 'alarm' | 'notification' };

/**
 * Event moments nobody answered: the server's `missed`, or — when the phone has not heard from it
 * (offline) — 30 min past with no «Сделано» / «Отложить» here. One row per occurrence; early alerts
 * («за час») are not rows of their own. Rows the person moved («Перенести») are left out.
 */
export function missedRows(
  s: Pick<ReturnType<typeof alarms>, 'fires' | 'reminders' | 'local'>,
  handled: string[],
  at: number = now(),
): MissedRow[] {
  const answered = new Set<string>();
  for (const f of Object.values(s.fires)) {
    if (f.state === 'acked' || s.local[f.key]?.ackedAt || s.local[f.key]?.snoozedUntil) answered.add(`${f.reminder_id}:${f.occurrence_at}`);
  }
  const out: MissedRow[] = [];
  for (const f of Object.values(s.fires)) {
    const r = s.reminders[f.reminder_id];
    if (!r || r.kind !== 'normal' || r.deleted_at || r.status === 'cancelled' || r.status === 'done') continue;
    if (f.offset_min !== 0 || f.snooze_n !== 0 || handled.includes(f.key)) continue;
    if (answered.has(`${f.reminder_id}:${f.occurrence_at}`)) continue;
    const late = f.state !== 'cancelled' && f.state !== 'snoozed' && Date.parse(f.fire_at) + MISSED_AFTER_MS <= at;
    if (f.state === 'missed' || late) out.push({ key: f.key, reminderId: r.id, title: r.title, at: Date.parse(f.occurrence_at), level: r.level });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * [Сделано] on a missed row: a late «Сделано» (the server turns `missed` into `acked`, reminders.md).
 * Shown at once; the event goes through the outbox, offline too.
 */
export async function ackLate(fireKey: string): Promise<string | null> {
  const s = alarms();
  const f = s.fires[fireKey];
  if (!f) return null;
  const at = now();
  const local = { ...s.local };
  for (const g of Object.values(s.fires)) {
    if (g.reminder_id === f.reminder_id && g.occurrence_at === f.occurrence_at) local[g.key] = { ...(local[g.key] ?? {}), ackedAt: at };
  }
  s.set({ local });
  const row = await queueEvents([
    { client_id: newId(), fire_key: fireKey, fire_id: fireId(fireKey), event: 'acked', at: new Date(at).toISOString(), meta: { surface: 'today' } },
  ]);
  await replan();
  return row;
}

/**
 * «Отменить» of [Сделано] on a missed row. reminders.md has no event that takes an `acked` back:
 * only while the event still waits in the outbox can it be dropped. Returns false when it went.
 */
export async function undoAckLate(fireKey: string, outboxId: string | null): Promise<boolean> {
  if (outboxId) {
    const outbox = await getOutbox();
    const row = await outbox.get(outboxId);
    if (row && row.status !== 'pending') return false;
    if (row) await outbox.markFailed(row.id, 'undone');
  }
  unackLocal(fireKey);
  await replan();
  return true;
}

/** «Отменить» of a late «Сделано» that has not gone yet: the row is missed again here. */
export function unackLocal(fireKey: string): void {
  const s = alarms();
  const f = s.fires[fireKey];
  if (!f) return;
  const local = { ...s.local };
  for (const g of Object.values(s.fires)) {
    if (g.reminder_id === f.reminder_id && g.occurrence_at === f.occurrence_at && local[g.key]) {
      const { ackedAt: _a, ...rest } = local[g.key]!;
      local[g.key] = rest;
    }
  }
  s.set({ local });
}

// --- week 9: «Удалить» a reminder (DELETE /reminders/{id}: 200 with its action) ---

const deleted = new Map<string, { reminder: ReminderOut; fires: Record<string, FireOut> }>();

/**
 * Stops ringing here at once (offline too); `reminder.delete` goes through the outbox. Returns the
 * outbox row id for «Отменить». Only reminders the server has (a local one has no id there yet).
 */
export async function deleteReminder(id: string): Promise<string | null> {
  const s = alarms();
  const r = s.reminders[id];
  if (!r || id.startsWith(LOCAL_PREFIX)) return null;
  const mine = Object.fromEntries(Object.entries(s.fires).filter(([, f]) => f.reminder_id === id));
  deleted.set(id, { reminder: r, fires: mine });
  const at = new Date(now()).toISOString();
  const fires = { ...s.fires };
  for (const [k, f] of Object.entries(mine)) if (f.state !== 'acked' && f.state !== 'missed') fires[k] = { ...f, state: 'cancelled' };
  s.set({ reminders: { ...s.reminders, [id]: { ...r, status: 'cancelled', deleted_at: at } }, fires });
  await replan();
  const row = await (await getOutbox()).enqueue('reminder.delete', { id });
  d().kickSync();
  return row.id;
}

/**
 * «Отменить» of «Удалить»: still in the outbox → it never goes and the reminder rings again here.
 * Sent → returns the action id: the caller undoes it (the server brings it back with new fires).
 */
export async function takeBackDelete(id: string, outboxId: string): Promise<{ local: boolean; actionId: string | null }> {
  const outbox = await getOutbox();
  const row = await outbox.get(outboxId);
  if (row?.status === 'pending') {
    await outbox.markFailed(row.id, 'undone');
    const was = deleted.get(id);
    if (was) {
      const s = alarms();
      s.set({ reminders: { ...s.reminders, [id]: was.reminder }, fires: { ...s.fires, ...was.fires } });
      await replan();
    }
    return { local: true, actionId: null };
  }
  return { local: false, actionId: ((row?.payload as { actionId?: string | null } | undefined)?.actionId ?? null) };
}
