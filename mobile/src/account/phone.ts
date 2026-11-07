import type { OtpRequestOut, OtpVerifyOut } from '@/api/types';
import { getOutbox, getRecords } from '@/db';
import { getApi, kickSync } from '@/services';
import { useOnboarding } from '@/store/onboarding';

export function sendPhoneCode(phone: string): Promise<OtpRequestOut> {
  return getApi().requestOtp({ phone, purpose: 'link' });
}

/**
 * The phone already belongs to an account: the new tokens are for that account, which has its own
 * records and consents and is new to this device. Fetch everything from the start and send what
 * this person agreed to on S05 again (the same texts, versions and hashes).
 */
async function moveToExistingAccount(): Promise<void> {
  await (await getRecords()).setCursor(0);
  const outbox = await getOutbox();
  const texts = useOnboarding.getState().consent?.texts ?? [];
  if (texts.length > 0) {
    await outbox.enqueue('consent.accept', {
      request: {
        screen: 'S05',
        age_confirmed_18: true,
        consents: texts.map((x) => ({ kind: x.kind, version: x.version, text_hash: x.textHash, locale: x.locale })),
      },
    });
  }
  await outbox.enqueue('device.register', {});
}

export async function confirmPhone(o: { challengeId: string; phone: string; code: string }): Promise<OtpVerifyOut> {
  const out = await getApi().verifyOtp({ challenge_id: o.challengeId, phone: o.phone, code: o.code });
  if (out.account_switched) await moveToExistingAccount();
  useOnboarding.getState().markPhoneLinked();
  kickSync();
  return out;
}
