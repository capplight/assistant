import path from 'path';

import { InMemoryOutboxRepository, setOutboxForTests } from '@/db';
import i18n from '@/i18n';
import { useAssistant } from '@/store/assistant';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';

export const APP_DIR = path.resolve(__dirname, '../app');

/** Reset all local state between tests; returns the in-memory outbox for assertions. */
export function resetApp(): InMemoryOutboxRepository {
  useOnboarding.getState().reset();
  usePages.getState().reset();
  useAssistant.getState().reset();
  void i18n.changeLanguage('ru');
  const outbox = new InMemoryOutboxRepository();
  setOutboxForTests(outbox);
  return outbox;
}

/** Mark onboarding finished with full consent (pages = seed: Заметки, Дела, Расходы). */
export function finishOnboarding(mode: 'full' | 'no_ai' = 'full'): void {
  const s = useOnboarding.getState();
  s.markWelcomeSeen(false);
  s.acceptConsent(mode);
  s.setPath('gallery');
  s.complete();
}
