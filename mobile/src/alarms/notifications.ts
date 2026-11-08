import { Platform } from 'react-native';

import { snoozeIds, type AlarmEvent, type AlarmPort, type AlarmSpec, type NotificationsState, type ScheduleResult } from './port';

/**
 * The fallback that rings as a notification (S14 variants B/D without our module):
 * - iOS < 26: time-sensitive notification + repeats as separate notifications (3-engineering 6.6);
 *   in silent mode it only vibrates — S15 says so;
 * - Expo Go (both platforms) and any build without modules/alarms: the same, Android with
 *   `delivery: 'alarmClock'` (exact) on a high-importance channel.
 * Taps on «Сделано» / «Отложить» are seen only while the app runs or as the last tap at the next
 * start (expo-notifications keeps one); a ring while the app was closed is reported from the tray.
 */
type N = typeof import('expo-notifications');

function load(): N | null {
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-notifications') as N;
  } catch {
    return null;
  }
}

export const ALARM_CATEGORY = 'assistant_alarm';
const CHANNEL_ALARM = 'assistant_alarm_fallback_v1';
const CHANNEL_QUIET = 'assistant_reminder_fallback_v1';

type Data = { assistantAlarm: true; group: string; alarmId: string; repeatN: number; kind: string; fireAt: number; dueAt: number; level: string; title: string };

const isOurs = (d: unknown): d is Data => !!d && typeof d === 'object' && (d as Data).assistantAlarm === true;

export async function notificationPermission(): Promise<NotificationsState> {
  const N = load();
  if (!N) return 'undetermined';
  try {
    const p = await N.getPermissionsAsync();
    return p.granted ? 'granted' : p.canAskAgain === false || p.status === 'denied' ? 'denied' : 'undetermined';
  } catch {
    return 'undetermined';
  }
}

/** S04: the system window. */
export async function requestNotificationPermission(): Promise<NotificationsState> {
  const N = load();
  if (!N) return 'undetermined';
  try {
    const p = await N.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
    return p.granted ? 'granted' : 'denied';
  } catch {
    return 'undetermined';
  }
}

let labels: Record<string, string> = {};

function timeOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function notificationAlarms(): AlarmPort {
  const N = load();
  const pending: AlarmEvent[] = [];
  const listeners = new Set<() => void>();
  let ready: Promise<void> | null = null;
  let n = 0;
  const push = (e: Omit<AlarmEvent, 'id'>) => {
    pending.push({ id: `nf-${e.at.toString(36)}-${(++n).toString(36)}`, ...e });
    for (const cb of listeners) cb();
  };

  const setup = () => {
    if (!N) return Promise.resolve();
    if (!ready) {
      ready = (async () => {
        if (Platform.OS === 'android') {
          await N.setNotificationChannelAsync(CHANNEL_ALARM, {
            name: labels.channel_alarms ?? 'Будильники',
            importance: N.AndroidImportance.MAX,
            sound: 'default',
            vibrationPattern: [0, 800, 400, 800, 400, 800, 400, 800],
            lockscreenVisibility: N.AndroidNotificationVisibility.PUBLIC,
            bypassDnd: true,
            audioAttributes: { usage: N.AndroidAudioUsage.ALARM, contentType: N.AndroidAudioContentType.SONIFICATION },
          });
          await N.setNotificationChannelAsync(CHANNEL_QUIET, {
            name: labels.channel_reminders ?? 'Напоминания',
            importance: N.AndroidImportance.HIGH,
          });
        }
        await N.setNotificationCategoryAsync(ALARM_CATEGORY, [
          { identifier: 'done', buttonTitle: labels.done ?? 'Сделано', options: { opensAppToForeground: false } },
          { identifier: 'snooze', buttonTitle: labels.snooze ?? 'Отложить на 10 минут', options: { opensAppToForeground: false } },
        ]);
      })().catch(() => undefined);
    }
    return ready;
  };

  const add = async (s: AlarmSpec): Promise<ScheduleResult> => {
    if (!N) return { id: s.id, scheduler: 'failed', error: 'no_module' };
    const data: Data = {
      assistantAlarm: true,
      group: s.group,
      alarmId: s.id,
      repeatN: s.repeatN,
      kind: s.kind,
      fireAt: s.fireAt,
      dueAt: s.dueAt,
      level: s.level,
      title: s.title,
    };
    const alarm = s.level === 'alarm';
    const request = (delivery?: 'alarmClock') => ({
      identifier: s.id,
      content: {
        title: s.title || (labels.reminder ?? 'Напоминание'),
        body: alarm ? `${labels.heading ?? 'Будильник-напоминание'} · ${timeOf(s.dueAt)}` : timeOf(s.dueAt),
        data,
        categoryIdentifier: ALARM_CATEGORY,
        sound: 'default',
        interruptionLevel: 'timeSensitive' as const,
        priority: alarm ? N.AndroidNotificationPriority.MAX : N.AndroidNotificationPriority.HIGH,
        sticky: alarm,
      },
      trigger: {
        type: N.SchedulableTriggerInputTypes.DATE,
        date: s.fireAt,
        channelId: alarm ? CHANNEL_ALARM : CHANNEL_QUIET,
        ...(delivery ? { delivery } : {}),
      } as const,
    });
    try {
      if (Platform.OS === 'android' && alarm) {
        try {
          await N.scheduleNotificationAsync(request('alarmClock'));
          return { id: s.id, scheduler: 'notification' };
        } catch {
          // no exact alarms in this build: a normal one, may be late
          await N.scheduleNotificationAsync(request());
          return { id: s.id, scheduler: 'inexact' };
        }
      }
      await N.scheduleNotificationAsync(request());
      return { id: s.id, scheduler: 'notification' };
    } catch (e) {
      return { id: s.id, scheduler: 'failed', error: e instanceof Error ? e.message : 'schedule' };
    }
  };

  const ours = async () => {
    if (!N) return [];
    try {
      return (await N.getAllScheduledNotificationsAsync()).filter((r) => isOurs(r.content.data));
    } catch {
      return [];
    }
  };

  const dropGroup = async (group: string): Promise<Data | null> => {
    if (!N) return null;
    let base: Data | null = null;
    for (const r of await ours()) {
      const d = r.content.data as Data;
      if (d.group !== group) continue;
      base = base ?? d;
      await N.cancelScheduledNotificationAsync(r.identifier).catch(() => undefined);
    }
    try {
      for (const p of await N.getPresentedNotificationsAsync()) {
        const d = p.request.content.data;
        if (isOurs(d) && d.group === group) {
          base = base ?? d;
          await N.dismissNotificationAsync(p.request.identifier).catch(() => undefined);
        }
      }
    } catch {
      // nothing on screen
    }
    return base;
  };

  const snooze = async (group: string, minutes: number) => {
    const base = await dropGroup(group);
    const until = Date.now() + minutes * 60_000;
    if (base) {
      const count = base.level === 'alarm' ? 3 : 0;
      const ids = snoozeIds(group, until, count);
      for (const [i, id] of ids.entries()) {
        await add({
          id,
          group,
          fireAt: until + i * 5 * 60_000,
          title: base.title,
          level: base.level === 'alarm' ? 'alarm' : 'notification',
          repeatN: i,
          kind: base.kind === 'test' ? 'test' : 'normal',
          dueAt: until,
        });
      }
    }
    push({ event: 'snoozed', group, at: Date.now(), until, minutes });
  };

  const fromResponse = (action: string, d: Data, at: number) => {
    if (action === 'done') {
      void dropGroup(d.group);
      push({ event: 'acked', group: d.group, alarmId: d.alarmId, repeatN: d.repeatN, kind: d.kind === 'test' ? 'test' : 'normal', at });
    } else if (action === 'snooze') {
      void snooze(d.group, 10);
    } else {
      // A tap on the notification itself: the app opens; S14 in the app takes it from here.
      push({ event: 'shown', group: d.group, alarmId: d.alarmId, repeatN: d.repeatN, kind: d.kind === 'test' ? 'test' : 'normal', surface: 'notification', at });
    }
  };

  if (N) {
    try {
      N.addNotificationReceivedListener((notif) => {
        const d = notif.request.content.data;
        if (isOurs(d)) {
          push({
            event: 'fired',
            group: d.group,
            alarmId: d.alarmId,
            repeatN: d.repeatN,
            kind: d.kind === 'test' ? 'test' : 'normal',
            fireAt: d.fireAt,
            surface: Platform.OS === 'ios' ? 'time_sensitive' : 'notification',
            at: Date.now(),
          });
        }
      });
      N.addNotificationResponseReceivedListener((r) => {
        const d = r.notification.request.content.data;
        if (isOurs(d)) fromResponse(r.actionIdentifier, d, Date.now());
      });
    } catch {
      // no native module (web / tests)
    }
  }

  const handledLaunch = new Set<string>();

  return {
    capabilities: async () => ({
      backend: N ? 'notifications' : 'none',
      platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
      osVersion: parseInt(String(Platform.Version), 10) || 0,
      vendor: Platform.OS === 'ios' ? 'apple' : 'other',
      manufacturer: null,
      model: null,
      notifications: await notificationPermission(),
      exactAlarms: null,
      fullScreen: null,
      batteryUnrestricted: null,
      autostartStep: false,
      alarmKit: null,
    }),
    requestNotifications: requestNotificationPermission,
    requestAlarmKit: async () => null,
    schedule: async (specs) => {
      if (!N) return specs.map((s) => ({ id: s.id, scheduler: 'failed' as const, error: 'no_module' }));
      await setup();
      const wanted = new Set(specs.map((s) => s.id));
      const have = new Map((await ours()).map((r) => [r.identifier, r.content.data as Data]));
      for (const [id] of have) if (!wanted.has(id)) await N.cancelScheduledNotificationAsync(id).catch(() => undefined);
      const out: ScheduleResult[] = [];
      for (const s of specs) {
        const prev = have.get(s.id);
        if (prev && prev.fireAt === s.fireAt && prev.title === s.title && prev.level === s.level) {
          out.push({ id: s.id, scheduler: 'notification' });
          continue;
        }
        if (s.fireAt <= Date.now()) {
          out.push({ id: s.id, scheduler: 'failed', error: 'past' });
          continue;
        }
        out.push(await add(s));
      }
      return out;
    },
    drainEvents: async () => {
      if (N) {
        // Rings while the app was closed: what is still in the tray was delivered.
        try {
          for (const p of await N.getPresentedNotificationsAsync()) {
            const d = p.request.content.data;
            if (isOurs(d)) {
              pending.push({
                id: `tray-${d.alarmId}`,
                event: 'fired',
                group: d.group,
                alarmId: d.alarmId,
                repeatN: d.repeatN,
                kind: d.kind === 'test' ? 'test' : 'normal',
                fireAt: d.fireAt,
                surface: 'notification',
                at: typeof p.date === 'number' ? p.date : Date.now(),
              });
            }
          }
          const last = await N.getLastNotificationResponseAsync();
          const d = last?.notification.request.content.data;
          const key = last ? `${last.notification.request.identifier}:${last.actionIdentifier}` : '';
          if (last && isOurs(d) && !handledLaunch.has(key)) {
            handledLaunch.add(key);
            fromResponse(last.actionIdentifier, d, Date.now());
          }
        } catch {
          // nothing to read
        }
      }
      return pending.splice(0, pending.length);
    },
    onEvent: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    act: async (group, action, minutes = 10) => {
      if (action === 'done') {
        await dropGroup(group);
        push({ event: 'acked', group, at: Date.now() });
      } else {
        await snooze(group, minutes);
      }
    },
    openSettings: async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Linking } = require('react-native') as typeof import('react-native');
        await Linking.openSettings();
        return true;
      } catch {
        return false;
      }
    },
    setLabels: (l) => {
      labels = l;
      ready = null; // category and channel names follow the language
    },
  };
}
