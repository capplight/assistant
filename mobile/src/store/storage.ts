import Storage from 'expo-sqlite/kv-store';
import { createJSONStorage, type StateStorage } from 'zustand/middleware';

/**
 * Synchronous key-value storage on top of expo-sqlite (kv-store), so persisted
 * stores hydrate before the first render (no flash of onboarding).
 * TODO(week 3+): move to SQLCipher-encrypted DB with key in expo-secure-store (3-engineering §2.1).
 */
const sqliteKv: StateStorage = {
  getItem: (name) => Storage.getItemSync(name),
  setItem: (name, value) => Storage.setItemSync(name, value),
  removeItem: (name) => {
    Storage.removeItemSync(name);
  },
};

export const persistStorage = createJSONStorage(() => sqliteKv);
