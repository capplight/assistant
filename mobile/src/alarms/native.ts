import { Platform } from 'react-native';

import {
  type AlarmCapabilities,
  type AlarmEvent,
  type AlarmKitState,
  type AlarmPort,
  type AlarmSpec,
  type NotificationsState,
  type ScheduleResult,
  type SettingsTarget,
  type Vendor,
} from './port';
import { notificationAlarms, notificationPermission, requestNotificationPermission } from './notifications';

/** The JS face of modules/alarms (AlarmsModule.kt / AlarmsModule.swift). Android returns plain values, iOS promises. */
type NativeAlarms = {
  getCapabilities(): Record<string, unknown>;
  requestAlarmKit?(): Promise<string>;
  schedule(specs: AlarmSpec[]): ScheduleResult[] | Promise<ScheduleResult[]>;
  drainEvents(): Record<string, unknown>[];
  act(group: string, action: string, minutes: number): unknown;
  openSettings(target: string): boolean;
  setLabels(labels: Record<string, string>): void;
  addListener(event: 'onAlarmEvent', cb: () => void): { remove(): void };
};

function loadModule(): NativeAlarms | null {
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireOptionalNativeModule } = require('expo') as typeof import('expo');
    // Expo Go and builds without the module: null, the app falls back to notifications.
    return requireOptionalNativeModule<NativeAlarms>('Alarms');
  } catch {
    return null;
  }
}

const VENDORS = new Set(['xiaomi', 'samsung', 'transsion', 'huawei', 'oppo', 'vivo', 'apple']);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function eventOf(o: Record<string, unknown>): AlarmEvent | null {
  const event = text(o.event);
  if (!event || !['fired', 'shown', 'acked', 'snoozed', 'dismissed', 'rescheduled'].includes(event)) return null;
  const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : undefined);
  return {
    id: text(o.id) ?? `${event}-${n('at') ?? Date.now()}`,
    event: event as AlarmEvent['event'],
    group: text(o.group) ?? '',
    at: n('at') ?? Date.now(),
    alarmId: text(o.alarmId) ?? undefined,
    repeatN: n('repeatN'),
    kind: o.kind === 'test' ? 'test' : 'normal',
    fireAt: n('fireAt'),
    surface: text(o.surface) ?? undefined,
    until: n('until'),
    minutes: n('minutes'),
    delayMs: n('delayMs'),
  };
}

/** The `alarms` module, or null when it is not in this build (Expo Go). */
export function nativeAlarms(): AlarmPort | null {
  const M = loadModule();
  if (!M) return null;
  const fallback = notificationAlarms();
  const isIos = Platform.OS === 'ios';

  const caps = async (): Promise<AlarmCapabilities> => {
    const c = M.getCapabilities();
    const notifications: NotificationsState = await notificationPermission();
    const vendor = text(c.vendor);
    const alarmKit = text(c.alarmKit);
    const backend = c.backend === 'android' ? 'android' : c.backend === 'alarmkit' ? 'alarmkit' : 'notifications';
    return {
      backend,
      platform: isIos ? 'ios' : 'android',
      osVersion: parseInt(String(c.osVersion ?? Platform.Version), 10) || 0,
      vendor: (vendor && VENDORS.has(vendor) ? vendor : 'other') as Vendor,
      manufacturer: text(c.manufacturer),
      model: text(c.model),
      // Android reports «switched off» itself; «not asked yet» only expo-notifications knows.
      notifications: c.notificationsEnabled === false && notifications === 'granted' ? 'denied' : notifications,
      exactAlarms: isIos ? null : bool(c.exactAlarms),
      fullScreen: isIos ? null : bool(c.fullScreen),
      batteryUnrestricted: isIos ? null : bool(c.batteryUnrestricted),
      autostartStep: c.autostartStep === true,
      alarmKit: alarmKit === 'authorized' || alarmKit === 'denied' || alarmKit === 'notDetermined' ? alarmKit : null,
    };
  };

  return {
    capabilities: caps,
    requestNotifications: requestNotificationPermission,
    requestAlarmKit: async () => {
      if (!M.requestAlarmKit) return null;
      const s = await M.requestAlarmKit();
      return s === 'authorized' || s === 'denied' || s === 'notDetermined' ? (s as AlarmKitState) : null;
    },
    schedule: async (specs) => {
      if (!isIos) return await Promise.resolve(M.schedule(specs));
      const c = M.getCapabilities();
      if (c.backend !== 'alarmkit' || c.alarmKit !== 'authorized') return fallback.schedule(specs);
      // iOS 26+: «Будильник» in AlarmKit, the quiet level as a notification.
      const alarms = specs.filter((s) => s.level === 'alarm');
      const quiet = specs.filter((s) => s.level !== 'alarm');
      const [a, b] = await Promise.all([Promise.resolve(M.schedule(alarms)), fallback.schedule(quiet)]);
      return [...a, ...b];
    },
    drainEvents: async () => {
      const own = M.drainEvents()
        .map(eventOf)
        .filter((e): e is AlarmEvent => e !== null);
      return isIos ? [...own, ...(await fallback.drainEvents())] : own;
    },
    onEvent: (cb) => {
      const sub = M.addListener('onAlarmEvent', cb);
      const off = isIos ? fallback.onEvent(cb) : () => undefined;
      return () => {
        sub.remove();
        off();
      };
    },
    act: async (group, action, minutes = 10) => {
      await Promise.resolve(M.act(group, action, minutes));
      if (isIos) await fallback.act(group, action, minutes);
    },
    openSettings: async (target: SettingsTarget) => {
      if (target === 'notifications' && isIos) return M.openSettings('app');
      return M.openSettings(target);
    },
    setLabels: (labels) => {
      try {
        M.setLabels(labels);
      } catch {
        // older build without labels
      }
    },
  };
}
