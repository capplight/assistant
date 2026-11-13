import { useOnboarding } from './onboarding';

/**
 * Where an unfinished first launch resumes (Ф-34): the welcome screen until «Начать» recorded the consents;
 * null after that (the main layout finishes a launch left half-way with the default pages, US-33).
 */
export function useOnboardingResumeHref(): '/welcome' | null {
  const hasConsent = useOnboarding((s) => s.consent !== null);
  const doneAt = useOnboarding((s) => s.doneAt);
  if (doneAt || hasConsent) return null;
  return '/welcome';
}
