/* eslint-disable @typescript-eslint/no-require-imports */
// Native modules that have no JS implementation under Jest.

jest.mock('expo-sqlite/kv-store', () => {
  const mem = new Map<string, string>();
  const Storage = {
    getItemSync: (k: string) => mem.get(k) ?? null,
    setItemSync: (k: string, v: string) => void mem.set(k, v),
    removeItemSync: (k: string) => mem.delete(k),
    clearSync: () => {
      mem.clear();
      return true;
    },
  };
  return { __esModule: true, default: Storage, Storage };
});

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    throw new Error('SQLite is not available in Jest');
  }),
}));

jest.mock('@expo-google-fonts/onest', () => ({
  useFonts: () => [true, null],
  Onest_400Regular: 'Onest_400Regular',
  Onest_500Medium: 'Onest_500Medium',
  Onest_600SemiBold: 'Onest_600SemiBold',
  Onest_700Bold: 'Onest_700Bold',
}));

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'ru' }] }));

// RN's Jest preset reports fontScale 2 by default; tests run at 100% unless they opt into large font.
{
  const { Dimensions } = require('react-native');
  const dims = { width: 390, height: 844, scale: 3, fontScale: 1 };
  Dimensions.set({ window: dims, screen: dims });
}

// --- week 2: secure store, crypto, audio, share intent, file system ---

jest.mock('expo-secure-store', () => {
  const mem = new Map<string, string>();
  return {
    __esModule: true,
    AFTER_FIRST_UNLOCK: 0,
    getItemAsync: jest.fn(async (k: string) => mem.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void mem.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void mem.delete(k)),
    __mem: mem,
  };
});

jest.mock('expo-crypto', () => {
  const nodeCrypto = require('crypto');
  return {
    __esModule: true,
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    digestStringAsync: jest.fn(async (_alg: string, data: string) =>
      nodeCrypto.createHash('sha256').update(data, 'utf8').digest('hex'),
    ),
    getRandomBytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)),
    randomUUID: () => nodeCrypto.randomUUID(),
  };
});

jest.mock('expo-audio', () => {
  const recorder = {
    uri: null as string | null,
    n: 0,
    prepareToRecordAsync: jest.fn(async function (this: { n: number; uri: string | null }) {
      this.n += 1;
      this.uri = `file:///rec/${this.n}.m4a`;
    }),
    record: jest.fn(),
    stop: jest.fn(async () => undefined),
  };
  return {
    __esModule: true,
    AudioQuality: { MIN: 0, LOW: 32, MEDIUM: 64, HIGH: 96, MAX: 127 },
    IOSOutputFormat: { MPEG4AAC: 'aac ' },
    useAudioRecorder: () => recorder,
    useAudioRecorderState: () => ({ isRecording: false, durationMillis: 0, canRecord: true, metering: -20 }),
    requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted', canAskAgain: true })),
    setAudioModeAsync: jest.fn(async () => undefined),
    __recorder: recorder,
  };
});

jest.mock('expo-share-intent', () => ({
  __esModule: true,
  ShareIntentProvider: ({ children }: { children: unknown }) => children,
  useShareIntentContext: () => ({
    isReady: true,
    hasShareIntent: false,
    shareIntent: { files: null, type: null, webUrl: null, text: null },
    resetShareIntent: () => undefined,
    error: null,
  }),
  getShareExtensionKey: () => 'assistantShareKey',
}));

jest.mock('expo-file-system', () => ({
  __esModule: true,
  Paths: { document: { uri: 'file:///doc/' }, cache: { uri: 'file:///cache/' } },
  File: jest.fn(),
  Directory: jest.fn(),
}));
