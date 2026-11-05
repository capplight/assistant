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
