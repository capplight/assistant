import { useOnboarding } from './onboarding';

/** Where an unfinished first launch resumes (S01–S02 → S05 → S41); null when done. */
export function useOnboardingResumeHref(): '/welcome' | '/consent' | '/start' | null {
  const welcomeSeenAt = useOnboarding((s) => s.welcomeSeenAt);
  const hasConsent = useOnboarding((s) => s.consent !== null);
  const doneAt = useOnboarding((s) => s.doneAt);
  if (doneAt) return null;
  if (!welcomeSeenAt) return '/welcome';
  if (!hasConsent) return '/consent';
  return '/start';
}
