import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { ConsentTextOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { getApi, syncBlocked } from '@/services';
import { useConnectivity } from '@/store/connectivity';
import { useOnboarding } from '@/store/onboarding';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

import { AI_CONSENT_VERSION, sha256Hex } from './texts';

/** «Не сейчас» this launch: asked again next time the app starts. */
let postponed = false;

/** The local record names an older AI text (v1): the person accepted before DeepInfra was added. */
export function aiConsentOutdated(): boolean {
  const c = useOnboarding.getState().consent;
  if (!c || c.mode !== 'full') return false;
  const ai = c.texts.find((x) => x.kind === 'ai_cross_border');
  return !!ai && ai.version !== AI_CONSENT_VERSION;
}

/**
 * The AI text got a new recipient (`ai-2026-11-v2`, + DeepInfra for search by meaning, docs/api/search.md). A person
 * with a v1 grant keeps everything else and searches by words until they accept v2 — so a small sheet (Ф-65/Ф-66:
 * not a full screen) shows the exact new text once per launch: «Согласен» records that text (version + hash),
 * «Не сейчас» keeps the word search. Nothing is asked offline, before sign-in or in «Без ИИ».
 */
export function AiConsentUpdate() {
  const theme = useTheme();
  const { t } = useTranslation();
  const online = useConnectivity((s) => s.online);
  const outdated = useOnboarding(() => aiConsentOutdated());
  const blocked = useOnboarding((s) => s.accountConsent !== null);
  const [text, setText] = useState<ConsentTextOut | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!outdated || !online || blocked || postponed || syncBlocked()) return;
    let alive = true;
    void (async () => {
      try {
        const api = getApi();
        const state = await api.consents();
        const active = state.active.find((c) => c.kind === 'ai_cross_border' && !c.revoked_at);
        const locale = useOnboarding.getState().language;
        if (active?.version === AI_CONSENT_VERSION) return markAccepted(AI_CONSENT_VERSION, active.text_hash ?? '', active.locale ?? locale);
        // «Без ИИ» on the server (no AI grant at all): not this sheet's question.
        if (!active) return;
        const next = await api.getConsentText('ai_cross_border', locale);
        if (next.version !== AI_CONSENT_VERSION || (await sha256Hex(next.text)) !== next.text_hash) return;
        if (alive) setText(next);
      } catch {
        // Asked again next launch.
      }
    })();
    return () => {
      alive = false;
    };
  }, [outdated, online, blocked]);

  if (!text) return null;
  const later = () => {
    postponed = true;
    setText(null);
  };
  const accept = async () => {
    setBusy(true);
    try {
      await getApi().grantConsents({
        consents: [{ kind: 'ai_cross_border', version: text.version, text_hash: text.text_hash, locale: text.locale }],
        screen: 'settings',
        age_confirmed_18: true,
      });
      markAccepted(text.version, text.text_hash, text.locale);
      setText(null);
    } catch {
      useToast.getState().show(t('errors.generic'), 4000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      visible
      testID="ai-consent-update"
      title={t('consent_update.title')}
      // QA B «Поиск по смыслу» 1: one way out — «Не сейчас» (no second «Закрыть» on top).
      closeButton={false}
      onClose={later}
      footer={
        <View style={{ gap: theme.space[2] }}>
          <Button testID="ai-consent-accept" label={t('consent_update.accept')} disabled={busy} onPress={() => void accept()} />
          <Button testID="ai-consent-later" label={t('consent_update.later')} variant="text" onPress={later} />
        </View>
      }
    >
      <AppText color="ink2">{t('consent_update.why')}</AppText>
      <AppText testID="ai-consent-text">{text.text}</AppText>
    </Sheet>
  );
}

function markAccepted(version: string, textHash: string, locale: string): void {
  const s = useOnboarding.getState();
  const c = s.consent;
  if (!c) return;
  const texts = c.texts.map((x) => (x.kind === 'ai_cross_border' ? { ...x, version, textHash, locale } : x));
  useOnboarding.setState({ consent: { ...c, texts } });
}
