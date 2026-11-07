import { Platform } from 'react-native';

import { ApiClient, type FetchLike } from '@/api/client';
import { getAppVersion } from '@/api/config';
import { Api, type PutFile } from '@/api/endpoints';
import { TokenStorage, type SecretStore } from '@/api/tokens';
import { getOutbox, getPagesRepo, getRecords } from '@/db';
import { RecordActions } from '@/records/actions';
import { Capture, type FileOps } from '@/records/capture';
import { useDataVersion } from '@/store/data';
import { useOnboarding } from '@/store/onboarding';
import { syncPagesStore } from '@/store/pagesSync';
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
};

let overrides: Overrides = {};
let api: Api | null = null;
let engine: Promise<SyncEngine> | null = null;
let capture: Promise<Capture> | null = null;
let actions: Promise<RecordActions> | null = null;

const deviceInfo: DeviceInfo = () => ({
  platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
  os_version: String(Platform.Version ?? ''),
  app_version: getAppVersion(),
  capabilities: {},
});

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
      baseUrl: overrides.baseUrl,
      tokens: new TokenStorage(overrides.secrets),
      locale: () => useOnboarding.getState().language,
    });
    api = new Api(client, overrides.putFile ?? ((uri, put) => nativePut()(uri, put)));
  }
  return api;
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
      }))();
  }
  return engine;
}

/**
 * Try to sync now, in the background. Nothing leaves the phone before S05 (consent gate, §6.14):
 * without a local consent record this is a no-op (anonymous sign-in happens with the consent send).
 */
export function kickSync(): void {
  if (useOnboarding.getState().consent === null) return;
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
  if (useOnboarding.getState().consent === null) return;
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

/** Test hook: replace native/network pieces; resets the singletons. */
export function setServicesForTests(o: Overrides): void {
  overrides = o;
  api = null;
  engine = null;
  capture = null;
  actions = null;
}
