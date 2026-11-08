import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { FireOut, ReminderDraft, ReminderOut } from '@/api/types';
import { persistStorage } from '@/store/storage';

import type { LocalFireState } from './plan';
import type { AlarmCapabilities } from './port';

/**
 * Reminders and their fires on this phone (server copy from /sync, /reminders/fires and the
 * answers of POST /reminders and /reminders/events), plus what only the phone knows: its own
 * reactions not yet confirmed, the S15 marks, the test alarm, phrases waiting for the internet.
 * kv-store, not SQLite: ≤ 14 days of fires is small. TODO: SQLite tables `reminders`, `fires`
 * (3-engineering §2.1) when lists of reminders arrive (week 9).
 */
export type TestState =
  | { state: 'idle' }
  | { state: 'waiting'; group: string | null; reminderClientId: string; dueAt: number }
  | { state: 'ok'; at: number; delayMs: number | null }
  | { state: 'failed'; at: number };

/** A phrase that looked like a reminder while offline: parsed once there is internet → S13. */
export type PendingPhrase = { id: string; text: string; at: number };
/** The parse came back: «Проверьте напоминание» → S13 with it. */
export type ReadyDraft = { id: string; text: string; draft: ReminderDraft | null; message: string | null; options: ReminderDraft[] };

export type SentEvent = { key: string; at: number };

type State = {
  /** By server id (or `local:<client_id>` until POST /reminders answers). */
  reminders: Record<string, ReminderOut>;
  /** By fire `key`. */
  fires: Record<string, FireOut>;
  local: Record<string, LocalFireState>;
  /** Local fire key (saved offline) → the server's key, so events queued before the answer find it. */
  aliases: Record<string, string>;
  /** The server id of this phone (POST /devices, /reminders/fires, /reminders/active). */
  deviceId: string | null;
  /** The server's Ф-1 setting from /reminders/settings. */
  parser: 'rules_first' | 'llm' | null;
  /** `snooze_max_hours` from /reminders/settings. */
  snoozeMaxHours: number;
  /** fire key → scheduler of the last plan, to send `scheduled_local` only when it changes. */
  reported: Record<string, string>;
  /** `${alarmId|group}:${event}` already handled: native events may come twice. */
  seen: SentEvent[];
  caps: AlarmCapabilities | null;
  /** S15 */
  offeredAt: string | null;
  laterAt: string | null;
  autostartConfirmedAt: string | null;
  batteryConfirmedAt: string | null;
  test: TestState;
  /** S04: the notification window was shown (asked once by itself). */
  notifyAskedAt: string | null;
  pendingPhrases: PendingPhrase[];
  drafts: ReadyDraft[];
  lastActiveAt: number;
  set: (p: Partial<Omit<State, 'set' | 'reset'>>) => void;
  reset: () => void;
};

const initial = {
  reminders: {},
  fires: {},
  local: {},
  aliases: {},
  deviceId: null,
  parser: null,
  snoozeMaxHours: 48,
  reported: {},
  seen: [],
  caps: null,
  offeredAt: null,
  laterAt: null,
  autostartConfirmedAt: null,
  batteryConfirmedAt: null,
  test: { state: 'idle' } as TestState,
  notifyAskedAt: null,
  pendingPhrases: [],
  drafts: [],
  lastActiveAt: 0,
};

export const useAlarms = create<State>()(
  persist(
    (set) => ({
      ...initial,
      set: (p) => set(p),
      reset: () => set(initial),
    }),
    {
      name: 'alarms',
      storage: persistStorage,
      version: 1,
      partialize: ({ set: _s, reset: _r, caps: _c, ...rest }) => rest,
    },
  ),
);

export const alarms = () => useAlarms.getState();
