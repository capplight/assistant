import { router } from 'expo-router';

import { ConsentForm } from '@/consent/ConsentForm';
import { getOutbox } from '@/db';
import { kickSync } from '@/services';
import { useOnboarding } from '@/store/onboarding';

/** S05 on the first launch: the choice is kept locally at once, the outbox sends it (R-03/R-04). */
export default function ConsentScreen() {
  const acceptConsent = useOnboarding((s) => s.acceptConsent);
  return (
    <ConsentForm
      onAccept={async (mode, request) => {
        acceptConsent(
          mode,
          request.consents.map((c) => ({ kind: c.kind, version: c.version, textHash: c.text_hash, locale: c.locale })),
        );
        // Local first; the outbox sends consents, then registers the device (devices need consent).
        const outbox = await getOutbox();
        await outbox.enqueue('consent.accept', { request });
        await outbox.enqueue('device.register', {});
        kickSync();
        router.replace('/start');
      }}
    />
  );
}
