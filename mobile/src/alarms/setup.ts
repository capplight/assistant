import type { AlarmCapabilities, SettingsTarget } from './port';

/**
 * S15 «Надёжность будильников» (2-design S15, 3-engineering 6.6 «Разрешения», R-12). Which steps
 * this phone has and which are done. Android: notifications, exact alarms (12+), full screen (14+),
 * the maker's «Автозапуск» (confirmed by hand — no API tells), battery «Без ограничений». iOS 26+:
 * notifications + the AlarmKit window. iOS < 26 and builds without our module: notifications only,
 * plus an honest line about what does not work there.
 */
export type StepKey = 'notifications' | 'exact' | 'full_screen' | 'autostart' | 'battery' | 'alarmkit';

export type SetupStep = {
  key: StepKey;
  done: boolean;
  /** The system screen [Открыть] goes to; null: a system window instead (notifications, AlarmKit). */
  target: SettingsTarget | null;
  /** «Я включил»: the phone cannot check this one. */
  confirmByHand: boolean;
};

export type SetupMarks = { autostartConfirmedAt: string | null; batteryConfirmedAt: string | null };

export function setupSteps(c: AlarmCapabilities, marks: SetupMarks): SetupStep[] {
  const steps: SetupStep[] = [];
  const notificationsDone = c.notifications === 'granted';
  steps.push({
    key: 'notifications',
    done: notificationsDone,
    target: c.notifications === 'denied' ? 'notifications' : null,
    confirmByHand: false,
  });
  if (c.backend === 'android') {
    if (c.exactAlarms !== null) steps.push({ key: 'exact', done: c.exactAlarms, target: 'exact', confirmByHand: false });
    if (c.fullScreen !== null && c.osVersion >= 34) {
      steps.push({ key: 'full_screen', done: c.fullScreen, target: 'full_screen', confirmByHand: false });
    }
    if (c.autostartStep) {
      steps.push({ key: 'autostart', done: marks.autostartConfirmedAt !== null, target: 'autostart', confirmByHand: true });
    }
    // Samsung and the rest: the system says whether the app is exempt; Xiaomi also has its own switch.
    const battery = c.batteryUnrestricted === true || (c.vendor === 'xiaomi' && marks.batteryConfirmedAt !== null);
    steps.push({ key: 'battery', done: battery, target: 'battery', confirmByHand: c.vendor === 'xiaomi' });
  }
  if (c.backend === 'alarmkit') {
    steps.push({ key: 'alarmkit', done: c.alarmKit === 'authorized', target: c.alarmKit === 'denied' ? 'app' : null, confirmByHand: false });
  }
  return steps;
}

export function allDone(c: AlarmCapabilities, marks: SetupMarks): boolean {
  return setupSteps(c, marks).every((s) => s.done);
}

/** Only a notification here, no alarm screen: Expo Go / a build without the module on Android. */
export function noAlarmScreen(c: AlarmCapabilities): boolean {
  return c.backend === 'notifications' || c.backend === 'none';
}

/** iOS < 26: «Если телефон на беззвучном, будильник будет только вибрировать» (2-design 2.8). */
export function silentModeWarning(c: AlarmCapabilities): boolean {
  return c.platform === 'ios' && c.backend !== 'alarmkit';
}

/**
 * «Будильники могут не сработать на этом телефоне [Исправить]» (alarm.risk, 2-design 4.8): a step
 * is not done. Shown only once the person has a reminder or went through S15 once.
 */
export function alarmRisk(c: AlarmCapabilities | null, marks: SetupMarks): boolean {
  if (!c || c.backend === 'none') return false;
  return !allDone(c, marks) || (c.backend === 'notifications' && c.platform === 'android');
}

/** Android 14+ shows S15 right after S04b (R-12, US-9). */
export function s15AfterPhone(c: AlarmCapabilities | null): boolean {
  return c?.platform === 'android' && c.osVersion >= 34;
}

/** `devices.capabilities` (3-engineering 3.x): what is done on this phone, for metrics and support. */
export function deviceCapabilities(c: AlarmCapabilities | null, marks: SetupMarks): Record<string, unknown> {
  if (!c) return {};
  return {
    alarm_backend: c.backend,
    alarmkit: c.alarmKit === 'authorized',
    exact_alarm_granted: c.exactAlarms,
    full_screen_intent: c.fullScreen,
    notifications_granted: c.notifications === 'granted',
    battery_unrestricted: c.batteryUnrestricted,
    autostart_confirmed: marks.autostartConfirmedAt !== null,
    s15_done: allDone(c, marks),
  };
}
