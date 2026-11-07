import { Platform } from 'react-native';

import { ApiClient, type FetchLike } from '@/api/client';
import { getAppVersion } from '@/api/config';
import { Api, type PutFile } from '@/api/endpoints';
import { TokenStorage, type SecretStore } from '@/api/tokens';
import { getOutbox, getPagesRepo, getRecords, type LocalRecord } from '@/db';
import { RecordActions } from '@/records/actions';
import { nativePush, type DeviceToken, type PushPort } from '@/push';
import { Capture, type FileOps } from '@/records/capture';
import { useDataVersion } from '@/store/data';
import { useConnectivity } from '@/store/connectivity';
import { useOnboarding } from '@/store/onboarding';
import { syncPagesStore } from '@/store/pagesSync';
import { useSession } from '@/store/session';
import { useUndo } from '@/store/undo';
import { SyncEngine, type DeviceInfo } from '@/sync/engine';

/**
 * Composition root: one API client, one sync engine, one capture service per app process.
 * Native pieces (file system, presigned PUT) are loaded lazily so tests can replace them.
 */
type Overrides = {
  fetch?: FetchLike;
  secrets?: SecretStore;
  files?: FileOps;
  putFile?: PutFile;
  baseUrl?: () => string;
  push?: PushPort;
};

let overrides: Overrides = {};
let api: Api | null = null;
let engine: Promise<SyncEngine> | null = null;
let capture: Promise<Capture> | null = null;
let actions: Promise<RecordActions> | null = null;
let push: PushPort | null = null;
/** Sent with POST /devices once notifications are allowed (src/push). */
let pushToken: DeviceToken | null = null;

const deviceInfo: DeviceInfo = () => ({
  platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
  os_version: String(Platform.Version ?? ''),
  app_version: getAppVersion(),
  ...(pushToken ? { push_provider: pushToken.provider, push_token: pushToken.token } : {}),
  capabilities: {},
});

export function getPush(): PushPort {
  if (!push) push = overrides.push ?? nativePush();
  return push;
}

/** A new push token: the device row is updated through the outbox (devices need consent). */
export async function setPushToken(t: DeviceToken | null): Promise<void> {
  if (t?.token === pushToken?.token && t?.provider === pushToken?.provider) return;
  pushToken = t;
  if (!t || useOnboarding.getState().consent === null) return;
  await (await getOutbox()).enqueue('device.register', {});
  kickSync();
}

/** Local data changed: lists reload, tabs follow the pages table. */
export function notifyDataChanged(): void {
  useDataVersion.getState().bump();
  void getPagesRepo()
    .then(syncPagesStore)
    .catch(() => undefined);
}

function nativeFiles(): FileOps {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('@/records/files') as typeof import('@/records/files')).nativeFileOps;
}

function nativePut(): PutFile {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('@/api/putFile') as typeof import('@/api/putFile')).putFileNative;
}

export function getApi(): Api {
  if (!api) {
    const client = new ApiClient({
      fetch: overrides.fetch,
      // Answers stream (SSE): expo/fetch on the phone; tests pass one fetch for both.
      streamFetch: overrides.fetch,
      baseUrl: overrides.baseUrl,
      tokens: new TokenStorage(overrides.secrets),
      locale: () => useOnboarding.getState().language,
      isLinked: () => useOnboarding.getState().phoneLinkedAt !== null,
      onSignInRequired: () => useSession.getState().setNeedsSignIn(true),
      onReachable: (reachable) => useConnectivity.getState().setOnline(reachable),
    });
    api = new Api(client, overrides.putFile ?? ((uri, put) => nativePut()(uri, put)));
  }
  return api;
}

/**
 * Nothing goes to or comes from the server: the account has no consent yet (it may belong to
 * another account than the phone's records), or a linked account has to sign in first.
 */
export function syncBlocked(): boolean {
  return useOnboarding.getState().accountConsent !== null || useSession.getState().needsSignIn;
}

export function getSyncEngine(): Promise<SyncEngine> {
  if (!engine) {
    engine = (async () =>
      new SyncEngine({
        api: getApi(),
        outbox: await getOutbox(),
        records: await getRecords(),
        pages: await getPagesRepo(),
        installId: () => getApi().client.tokens.getOrCreateInstallId(),
        deviceInfo,
        onChanged: notifyDataChanged,
        onAutoMerged: (recordId, date) => useUndo.getState().showMerged(recordId, date),
        blocked: syncBlocked,
        onAccountConsentRejected: () =>
          useOnboarding.getState().requireAccountConsent({ userId: '', switched: false }),
      }))();
  }
  return engine;
}

/**
 * Try to sync now, in the background. Nothing leaves the phone before S05 (consent gate, §6.14):
 * without a local consent record this is a no-op (anonymous sign-in happens with the consent send).
 */
export function kickSync(): void {
  if (useOnboarding.getState().consent === null || syncBlocked()) return;
  void getSyncEngine()
    .then((e) => e.run())
    .catch(() => undefined);
}

export function getCapture(): Promise<Capture> {
  if (!capture) {
    capture = (async () =>
      new Capture({
        outbox: await getOutbox(),
        records: await getRecords(),
        files: overrides.files ?? nativeFiles(),
        onSaved: () => {
          useDataVersion.getState().bump();
          // Until this save's own attempt says otherwise, do not tell an online person to wait.
          useConnectivity.getState().setOnline(true);
          kickSync();
        },
      }))();
  }
  return capture;
}

/**
 * The person opened a card. GET tells the server they are looking (their record stops waiting for
 * the cheap overnight run) and brings what is new. Best-effort: the card already shows local data.
 */
export async function refreshRecord(serverId: string): Promise<void> {
  if (useOnboarding.getState().consent === null || syncBlocked()) return;
  try {
    const item = await getApi().getItem(serverId);
    await (await getRecords()).applyRemote(item);
    useDataVersion.getState().bump();
  } catch {
    // offline or gone: nothing changes
  }
}

export function getRecordActions(): Promise<RecordActions> {
  if (!actions) {
    actions = (async () =>
      new RecordActions({
        records: await getRecords(),
        outbox: await getOutbox(),
        onChanged: () => {
          useDataVersion.getState().bump();
          kickSync();
        },
      }))();
  }
  return actions;
}

/** A search hit that is not on this phone yet: bring it here, so the card can open. */
export async function fetchRecord(serverId: string): Promise<LocalRecord | null> {
  const records = await getRecords();
  await records.applyRemote(await getApi().getItem(serverId));
  useDataVersion.getState().bump();
  return records.findByServerId(serverId);
}

/** Test hook: replace native/network pieces; resets the singletons. */
export function setServicesForTests(o: Overrides): void {
  overrides = o;
  api = null;
  engine = null;
  capture = null;
  actions = null;
  push = null;
  pushToken = null;
}
