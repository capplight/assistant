import type { OtpRequestOut, OtpVerifyOut } from '@/api/types';
import { getOutbox } from '@/db';
import { getApi, getSyncEngine, kickSync } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { useSession } from '@/store/session';
import type { ProfilePayload } from '@/sync/engine';

import { moveRecordsToThisAccount } from './switch';

export function sendPhoneCode(phone: string): Promise<OtpRequestOut> {
  // Signed out of a linked account there is nothing to link to: this is a sign-in.
  const purpose = useSession.getState().needsSignIn ? 'login' : 'link';
  return getApi().requestOtp({ phone, purpose });
}

/** The name the person typed on S04b: right here at once, on the server through the outbox. */
export async function saveDisplayName(name: string): Promise<void> {
  const s = useOnboarding.getState();
  const value = name.trim();
  if (!value || value === s.displayName) return;
  s.setDisplayName(value);
  const payload: ProfilePayload = { displayName: value };
  await (await getOutbox()).enqueue('profile.update', payload);
  kickSync();
}

export type PhoneResult = OtpVerifyOut & {
  /** S05 has to be shown: this account has no consent, and nothing is sent until it does. */
  needsConsent: boolean;
  switched: boolean;
};

/**
 * Number confirmed. The tokens may be for another account than the one this phone worked as:
 * - the phone number belongs to another account (`account_switched`), or
 * - signed out, a different number was entered (a new id, even though nothing was "switched").
 *
 * That account's own consents decide about S05 (docs/api/auth.md); what was accepted on the previous
 * account is never resent. The block goes up and the running sync ends before the new tokens are saved,
 * so no request of this phone's queue can reach that account by accident.
 */
export async function confirmPhone(o: { challengeId: string; phone: string; code: string }): Promise<PhoneResult> {
  const api = getApi();
  const tokens = api.client.tokens;
  const out = await api.verifyOtp({ challenge_id: o.challengeId, phone: o.phone, code: o.code });

  const previous = await tokens.getUserId();
  const switched = out.account_switched || (previous !== null && previous !== out.user.id);
  const appEnabled = out.app_enabled ?? !switched;
  // Same account, S05 accepted offline: that consent is still on its way, no need to ask again.
  const consentOnItsWay =
    !switched && (await (await getOutbox()).listPending(500)).some((e) => e.kind === 'consent.accept');
  const needsConsent = !appEnabled && !consentOnItsWay;

  const s = useOnboarding.getState();
  if (switched || needsConsent) {
    s.requireAccountConsent({ userId: out.user.id, switched });
    await (await getSyncEngine()).whenIdle();
  }
  await tokens.saveTokens(out);
  useSession.getState().setNeedsSignIn(false);
  s.markPhoneLinked();

  // After a sign-in the server's name wins; it is not typed here, so nothing is sent.
  if (switched) s.setDisplayName(out.user.display_name ?? null);
  else if (out.user.display_name) s.setDisplayName(out.user.display_name);

  if (switched && !needsConsent) {
    // The account agreed long ago, on its own: its choice stands, and the records can go there.
    s.setConsentFromServer(out.ai_enabled ? 'full' : 'no_ai');
    await moveRecordsToThisAccount();
    await (await getOutbox()).enqueue('device.register', {});
    s.clearAccountConsent();
  }
  kickSync();
  return { ...out, needsConsent, switched };
}
