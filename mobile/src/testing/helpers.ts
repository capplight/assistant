import path from 'path';

import type { FetchLike } from '@/api/client';
import { MemorySecretStore } from '@/api/tokens';
import { InMemoryOutboxRepository, InMemoryPagesRepository, InMemoryRecordsRepository, setOutboxForTests } from '@/db';
import i18n from '@/i18n';
import type { FileOps } from '@/records/capture';
import { setServicesForTests } from '@/services';
import { useAssistant } from '@/store/assistant';
import { useConnectivity } from '@/store/connectivity';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { useSession } from '@/store/session';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import { FakePush } from '@/push';
import { FakeAlarms } from '@/alarms/port';
import { useAlarms } from '@/alarms/store';
import { useTasks } from '@/tasks/store';
import { useToday } from '@/today/service';
import { useDedup } from '@/dedup/store';
import { setFilePickerForTests } from '@/dedup/pickFile';
import { useCatalog } from '@/pages/catalog';
import { useFacets } from '@/pages/facets';
import { useExpenses } from '@/expenses/store';

export const APP_DIR = path.resolve(__dirname, '../app');

/** fetch that behaves like a phone without network. */
export const offlineFetch: FetchLike = async () => {
  throw new TypeError('Network request failed');
};

/** Files "persisted" in memory: size = path length, sha256 = fixed fake. */
export const fakeFiles: FileOps = {
  persist: async (_src, name) => `file:///doc/records/${name}`,
  size: async (uri) => uri.length,
  sha256: async () => 'a'.repeat(64),
};

/** JSON Response for fetch mocks. */
export function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

export let testRecords = new InMemoryRecordsRepository();
/** The push port of the current test (no native module is loaded in tests). */
export let testPush = new FakePush();
export let testPages = new InMemoryPagesRepository();
/** The alarm port of the current test (no native module in Jest). */
export let testAlarms = new FakeAlarms();

/** Reset all local state between tests; returns the in-memory outbox for assertions. Network: offline. */
export function resetApp(o: { fetch?: FetchLike; push?: FakePush; alarms?: FakeAlarms } = {}): InMemoryOutboxRepository {
  useOnboarding.getState().reset();
  useAlarms.getState().reset();
  useTasks.getState().reset();
  useExpenses.getState().reset();
  useDedup.getState().reset();
  useCatalog.getState().reset();
  useFacets.getState().reset();
  setFilePickerForTests(null);
  useToday.setState({ last: null, answered: [] });
  usePages.getState().reset();
  useAssistant.getState().reset();
  useSession.getState().reset();
  useConnectivity.setState({ online: true });
  useToast.setState({ toast: null });
  useUndo.setState({ strip: null });
  useView.getState().reset();
  void i18n.changeLanguage('ru');
  const outbox = new InMemoryOutboxRepository();
  testRecords = new InMemoryRecordsRepository();
  testPages = new InMemoryPagesRepository();
  setOutboxForTests(outbox, testRecords, testPages);
  setServicesForTests({
    fetch: o.fetch ?? offlineFetch,
    secrets: new MemorySecretStore(),
    files: fakeFiles,
    putFile: async () => undefined,
    baseUrl: () => 'http://api.test',
    push: (testPush = o.push ?? new FakePush()),
    alarms: (testAlarms = o.alarms ?? new FakeAlarms()),
  });
  return outbox;
}

/** Mark onboarding finished with full consent (pages = seed: Заметки, Дела, Расходы). */
export function finishOnboarding(mode: 'full' | 'no_ai' = 'full'): void {
  const s = useOnboarding.getState();
  s.markWelcomeSeen(false);
  s.acceptConsent(mode);
  s.setPath('gallery');
  s.complete();
  s.markPhoneAsked(); // S04b has its own tests
}

/** renderRouter() switches Jest to fake timers (expo-router/testing-library); detect that. */
function fakeTimersOn(): boolean {
  return typeof (setTimeout as unknown as { clock?: unknown }).clock === 'object' || jest.isMockFunction(setTimeout);
}

/**
 * Wait for async app work (fetch mocks, outbox writes) step by step: each step is one awaited act()
 * that advances 20 ms of (fake or real) time. Unlike polling waitFor, steps never overlap, and it
 * works under the fake timers renderRouter() turns on (a plain setTimeout would never fire there).
 */
export async function settle(cond: () => boolean, maxSteps = 500): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { act } = require('expo-router/testing-library') as typeof import('expo-router/testing-library');
  for (let i = 0; i < maxSteps; i++) {
    if (cond()) return;
    await act(async () => {
      if (fakeTimersOn()) await jest.advanceTimersByTimeAsync(20);
      else await new Promise((r) => setTimeout(r, 20));
    });
  }
  if (!cond()) throw new Error('settle: condition not met');
}
