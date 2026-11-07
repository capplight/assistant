import { Platform } from 'react-native';

/**
 * Push «Ответ готов» (3-engineering 6.11 п. 4, R-14): the server sends it without any text when an
 * answer finished after the person left; a tap opens «Переписка» on that answer.
 *
 * Client side only, and UNVERIFIED: a push needs a development build with FCM / APNs credentials
 * (google-services.json, an APNs key), which this repo does not have. Native device tokens
 * (`getDevicePushTokenAsync`, 3-engineering §2.1): the server sends through FCM HTTP v1 / APNs itself.
 * The permission is NOT asked here: S04 asks for notifications (week 8, with reminders). Until then
 * a token is sent only if the person allowed notifications some other way.
 *
 * Everything native is behind `PushPort`, so tests use `FakePush` and nothing loads the module.
 */
export type DeviceToken = { provider: 'fcm' | 'apns'; token: string };

export interface PushPort {
  /** Notifications allowed (does not ask). */
  granted(): Promise<boolean>;
  deviceToken(): Promise<DeviceToken | null>;
  /** The person tapped a notification. Returns unsubscribe. */
  onOpened(cb: (data: unknown) => void): () => void;
  /** A notification arrived while the app is open. Returns unsubscribe. */
  onReceived(cb: (data: unknown) => void): () => void;
  /** The tap that started the app, if any. */
  lastOpened(): Promise<unknown>;
  /** In the foreground the answer shows in the app itself: no system banner for «Ответ готов». */
  quietInForeground(): void;
}

type NotificationsModule = typeof import('expo-notifications');

function load(): NotificationsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-notifications') as NotificationsModule;
  } catch {
    return null;
  }
}

const dataOf = (r: { notification: { request: { content: { data?: unknown } } } } | null | undefined): unknown =>
  r?.notification.request.content.data ?? null;

/** expo-notifications on a phone. Every call is best effort: a missing module or credentials = no push. */
export function nativePush(): PushPort {
  const N = load();
  const none = () => () => undefined;
  if (!N || Platform.OS === 'web') {
    return {
      granted: async () => false,
      deviceToken: async () => null,
      onOpened: none,
      onReceived: none,
      lastOpened: async () => null,
      quietInForeground: () => undefined,
    };
  }
  return {
    granted: async () => {
      try {
        return (await N.getPermissionsAsync()).granted;
      } catch {
        return false;
      }
    },
    deviceToken: async () => {
      try {
        const t = await N.getDevicePushTokenAsync();
        if (typeof t.data !== 'string') return null;
        return { provider: t.type === 'ios' ? 'apns' : 'fcm', token: t.data };
      } catch {
        return null; // Expo Go, no credentials, no Play services
      }
    },
    onOpened: (cb) => {
      const sub = N.addNotificationResponseReceivedListener((r) => cb(dataOf(r)));
      return () => sub.remove();
    },
    onReceived: (cb) => {
      const sub = N.addNotificationReceivedListener((n) => cb(n.request.content.data ?? null));
      return () => sub.remove();
    },
    lastOpened: async () => {
      try {
        const r = await N.getLastNotificationResponseAsync();
        if (r) await N.clearLastNotificationResponseAsync();
        return dataOf(r);
      } catch {
        return null;
      }
    },
    quietInForeground: () => {
      try {
        N.setNotificationHandler({
          handleNotification: async () => ({
            shouldPlaySound: false,
            shouldSetBadge: false,
            shouldShowBanner: false,
            shouldShowList: true,
          }),
        });
      } catch {
        // no native module
      }
    },
  };
}

/** Test double: `open(data)` / `receive(data)` act like a tap / an arrival. */
export class FakePush implements PushPort {
  allowed = false;
  token: DeviceToken | null = { provider: 'fcm', token: 'fake-token' };
  launchData: unknown = null;
  quiet = false;
  private opened = new Set<(d: unknown) => void>();
  private received = new Set<(d: unknown) => void>();

  granted = async () => this.allowed;
  deviceToken = async () => (this.allowed ? this.token : null);
  onOpened = (cb: (d: unknown) => void) => {
    this.opened.add(cb);
    return () => void this.opened.delete(cb);
  };
  onReceived = (cb: (d: unknown) => void) => {
    this.received.add(cb);
    return () => void this.received.delete(cb);
  };
  lastOpened = async () => {
    const d = this.launchData;
    this.launchData = null;
    return d;
  };
  quietInForeground = () => {
    this.quiet = true;
  };
  open(data: unknown) {
    for (const cb of this.opened) cb(data);
  }
  receive(data: unknown) {
    for (const cb of this.received) cb(data);
  }
}
