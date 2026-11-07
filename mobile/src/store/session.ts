import { create } from 'zustand';

/**
 * Sign-in state of this run. Not persisted: `needsSignIn` follows from the tokens at every launch,
 * and «Позже» on S04b or S05 lasts until the next launch.
 */
type SessionState = {
  /** A linked account lost its session: only the phone number can open it again. */
  needsSignIn: boolean;
  signInPostponed: boolean;
  consentPostponed: boolean;
  setNeedsSignIn: (v: boolean) => void;
  postponeSignIn: () => void;
  postponeConsent: () => void;
  reset: () => void;
};

const initial = { needsSignIn: false, signInPostponed: false, consentPostponed: false };

export const useSession = create<SessionState>()((set) => ({
  ...initial,
  setNeedsSignIn: (needsSignIn) => set({ needsSignIn }),
  postponeSignIn: () => set({ signInPostponed: true }),
  postponeConsent: () => set({ consentPostponed: true }),
  reset: () => set(initial),
}));
