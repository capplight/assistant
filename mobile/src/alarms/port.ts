/**
 * Everything that rings goes through `AlarmPort` (3-engineering 6.6), so the JS side plans the same
 * way on every phone and tests use `FakeAlarms`:
 * - `android`: the `alarms` module (modules/alarms): setAlarmClock + our full-screen S14 / heads-up;
 * - `alarmkit`: iOS 26+, the module schedules «Будильник» in AlarmKit, «Уведомление» goes as a
 *   time-sensitive notification;
 * - `notifications`: no module (Expo Go, iOS < 26): expo-notifications — time-sensitive on iOS,
 *   `alarmClock` delivery on Android. Rings as a notification, not as an alarm screen.
 */

export type AlarmLevel = 'alarm' | 'notification';

/** One planned ring. `group` = the server fire `key`: its repeats and «Отложить» keep it. */
export type AlarmSpec = {
  id: string;
  group: string;
  fireAt: number;
  title: string;
  level: AlarmLevel;
  /** 0 = the fire itself, 1–3 = repeats +5/+10/+15. */
  repeatN: number;
  kind: 'normal' | 'test';
  /** The time the person expects (shown on S14), the same for the repeats. */
  dueAt: number;
};

export type Scheduler = 'alarm_clock' | 'exact' | 'inexact' | 'alarmkit' | 'notification' | 'failed';

export type ScheduleResult = { id: string; scheduler: Scheduler; error?: string | null };

export type AlarmEventKind = 'fired' | 'shown' | 'acked' | 'snoozed' | 'dismissed' | 'rescheduled';

export type AlarmEvent = {
  id: string;
  event: AlarmEventKind;
  group: string;
  at: number;
  alarmId?: string;
  repeatN?: number;
  kind?: 'normal' | 'test';
  fireAt?: number;
  /** fsi | heads_up | notification | alarmkit | time_sensitive | blocked */
  surface?: string;
  until?: number;
  minutes?: number;
  delayMs?: number;
};

export type Backend = 'android' | 'alarmkit' | 'notifications' | 'none';
export type Vendor = 'xiaomi' | 'samsung' | 'transsion' | 'huawei' | 'oppo' | 'vivo' | 'apple' | 'other';
export type NotificationsState = 'granted' | 'denied' | 'undetermined';
export type AlarmKitState = 'authorized' | 'denied' | 'notDetermined';

/** What this phone allows. `null` = the question does not exist here (e.g. exact alarms on iOS). */
export type AlarmCapabilities = {
  backend: Backend;
  platform: 'android' | 'ios' | 'web';
  osVersion: number;
  vendor: Vendor;
  manufacturer: string | null;
  model: string | null;
  notifications: NotificationsState;
  /** Android 12+: SCHEDULE_EXACT_ALARM. false → «Может опоздать до 10 минут». */
  exactAlarms: boolean | null;
  /** Android 14+: full-screen alarms (S14 variant A); false → heads-up (B). */
  fullScreen: boolean | null;
  batteryUnrestricted: boolean | null;
  /** The maker has an «Автозапуск» screen (Xiaomi, Tecno/Infinix…): the person confirms it by hand. */
  autostartStep: boolean;
  alarmKit: AlarmKitState | null;
};

export type SettingsTarget = 'exact' | 'full_screen' | 'battery' | 'autostart' | 'notifications' | 'app';

export interface AlarmPort {
  capabilities(): Promise<AlarmCapabilities>;
  /** The system notification window (S04). */
  requestNotifications(): Promise<NotificationsState>;
  /** iOS 26+: the AlarmKit window, in the context of the first alarm. */
  requestAlarmKit(): Promise<AlarmKitState | null>;
  /** Replaces the whole plan. */
  schedule(specs: AlarmSpec[]): Promise<ScheduleResult[]>;
  /** Rings and button taps since the last call, including those while the app was closed. */
  drainEvents(): Promise<AlarmEvent[]>;
  /** Something to drain. Returns unsubscribe. */
  onEvent(cb: () => void): () => void;
  /** «Сделано» / «Отложить» from the app's own S14: stops the ring, drops or re-plans repeats. */
  act(group: string, action: 'done' | 'snooze', minutes?: number): Promise<void>;
  openSettings(target: SettingsTarget): Promise<boolean>;
  /** Button and channel texts for the native screens, in the person's language. */
  setLabels(labels: Record<string, string>): void;
}

export const REPEAT_MINUTES = [5, 10, 15] as const;
export const SNOOZE_MINUTES = 10;
/** reminders.md: `meta.until` from `at + 1 min` to `at + snooze_max_hours` (default 48 h). */
export const SNOOZE_MAX_HOURS = 48;

/** «Другое время» within what the server accepts: 1 minute … `maxHours`. */
export function clampSnoozeMinutes(minutes: number, maxHours: number = SNOOZE_MAX_HOURS): number {
  const max = Math.max(1, Math.floor(maxHours * 60));
  return Math.min(max, Math.max(1, Math.round(Number.isFinite(minutes) ? minutes : SNOOZE_MINUTES)));
}

/**
 * `meta.until` for a `snoozed` event: ISO 8601 with an offset (UTC `Z`), counted from the event's
 * own `at` and kept within [at + 1 min, at + maxHours]. null when there is no time to send.
 */
export function snoozeUntilFor(at: number, until: number | undefined, maxHours: number = SNOOZE_MAX_HOURS): string | null {
  if (until === undefined || !Number.isFinite(until)) return null;
  const lo = at + 60_000;
  const hi = at + maxHours * 3_600_000;
  return new Date(Math.min(hi, Math.max(lo, until))).toISOString();
}

let seq = 0;
const eventId = () => `ev-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** Snooze ids are the same on both sides: `${group}~s${until in base 36}~${n}`. */
export function snoozeIds(group: string, until: number, count: number): string[] {
  return Array.from({ length: count + 1 }, (_, n) => `${group}~s${until.toString(36)}~${n}`);
}

/**
 * Test double. `ring(id)` acts like the OS reaching the time, `press(group, …)` like a button on
 * the notification / S14. Scheduling keeps what it was given, like the module does.
 */
export class FakeAlarms implements AlarmPort {
  caps: AlarmCapabilities = {
    backend: 'android',
    platform: 'android',
    osVersion: 34,
    vendor: 'xiaomi',
    manufacturer: 'Xiaomi',
    model: 'Redmi Note 13',
    notifications: 'undetermined',
    exactAlarms: true,
    fullScreen: true,
    batteryUnrestricted: false,
    autostartStep: true,
    alarmKit: null,
  };
  planned: AlarmSpec[] = [];
  events: AlarmEvent[] = [];
  opened: SettingsTarget[] = [];
  labels: Record<string, string> = {};
  /** After `requestNotifications`. */
  answer: NotificationsState = 'granted';
  scheduleCalls = 0;
  private listeners = new Set<() => void>();

  capabilities = async () => ({ ...this.caps });
  requestNotifications = async () => {
    this.caps.notifications = this.answer;
    return this.answer;
  };
  requestAlarmKit = async () => {
    if (this.caps.alarmKit === null) return null;
    this.caps.alarmKit = 'authorized';
    return this.caps.alarmKit;
  };
  schedule = async (specs: AlarmSpec[]) => {
    this.scheduleCalls++;
    const now = Date.now();
    const scheduler: Scheduler =
      this.caps.backend === 'notifications'
        ? 'notification'
        : this.caps.backend === 'alarmkit'
          ? 'alarmkit'
          : this.caps.exactAlarms === false
            ? 'inexact'
            : 'alarm_clock';
    this.planned = specs.filter((s) => s.fireAt > now);
    return specs.map((s) =>
      s.fireAt > now ? { id: s.id, scheduler } : { id: s.id, scheduler: 'failed' as const, error: 'past' },
    );
  };
  drainEvents = async () => {
    const out = this.events;
    this.events = [];
    return out;
  };
  onEvent = (cb: () => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };
  act = async (group: string, action: 'done' | 'snooze', minutes = SNOOZE_MINUTES) => {
    this.press(group, action, minutes, false);
  };
  openSettings = async (target: SettingsTarget) => {
    this.opened.push(target);
    return true;
  };
  setLabels = (labels: Record<string, string>) => {
    this.labels = labels;
  };

  private emit(e: Omit<AlarmEvent, 'id' | 'at'> & { at?: number }, notify = true) {
    this.events.push({ id: eventId(), at: Date.now(), ...e });
    if (notify) for (const cb of this.listeners) cb();
  }

  /** The OS reached this ring's time. */
  ring(id: string, surface = 'fsi') {
    const spec = this.planned.find((s) => s.id === id);
    if (!spec) throw new Error(`no planned ring ${id}`);
    this.planned = this.planned.filter((s) => s.id !== id);
    this.emit({ event: 'fired', group: spec.group, alarmId: id, repeatN: spec.repeatN, kind: spec.kind, fireAt: spec.fireAt, surface });
  }

  /** A button on the notification or our S14. */
  press(group: string, action: 'done' | 'snooze', minutes = SNOOZE_MINUTES, notify = true) {
    const base = this.planned.find((s) => s.group === group);
    this.planned = this.planned.filter((s) => s.group !== group);
    if (action === 'done') {
      this.emit({ event: 'acked', group }, notify);
      return;
    }
    const until = Date.now() + minutes * 60_000;
    if (base) {
      const count = base.level === 'alarm' ? REPEAT_MINUTES.length : 0;
      snoozeIds(group, until, count).forEach((id, n) =>
        this.planned.push({ ...base, id, fireAt: until + n * 5 * 60_000, repeatN: n, dueAt: until }),
      );
    }
    this.emit({ event: 'snoozed', group, until, minutes }, notify);
  }

  /** The phone rebooted: the module put everything back and says so. */
  rebooted() {
    this.emit({ event: 'rescheduled', group: '' });
  }
}
