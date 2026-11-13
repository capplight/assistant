import { router } from 'expo-router';
import { BellRing, KeyRound, Mic, ReceiptText } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon, type LucideIcon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { buildConsentRequest, consentScreen } from '@/consent/texts';
import { useConsentTexts } from '@/consent/useConsentTexts';
import { getOutbox } from '@/db';
import { LANGUAGES, type Language } from '@/i18n';
import { finishWithDefaults } from '@/onboarding/service';
import { kickSync } from '@/services';
import { getFeatures, useFeatures } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { useTheme } from '@/theme';

/**
 * The first launch (Ф-34): one welcome screen → «Начать» → «Сегодня». The line under the button says that
 * «Начать» accepts the Privacy policy and the Terms (links); pressing it records the same consents S05 did
 * (each text's kind, version, sha256, locale; `screen` = the server's `consent_screen`, `welcome`), then
 * `POST /pages/batch {"path":"skipped"}` makes «Заметки» + «Дела». No page choice, no SMS, no alarm setup and no
 * notification prompt here: those are asked when needed (the first reminder asks for notifications). S05, S41,
 * the gallery and the phrase path stay in the code (Ф-33), off the first-launch path.
 */
export default function WelcomeScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const language = useOnboarding((s) => s.language);
  const setLanguage = useOnboarding((s) => s.setLanguage);
  const markOpened = useOnboarding((s) => s.markOpened);
  const forOther = useFeatures((f) => f.setup_for_other);
  const texts = useConsentTexts(language);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    markOpened(); // US-14 criterion A starts here
  }, [markOpened]);

  const begin = async () => {
    if (busy) return;
    setBusy(true);
    const s = useOnboarding.getState();
    const request = buildConsentRequest('full', texts, consentScreen(getFeatures().consent_screen));
    s.markWelcomeSeen(false);
    s.setPath('skipped'); // no page choice on the first launch (onboarding.md «skipped»)
    s.acceptConsent(
      'full',
      request.consents.map((c) => ({ kind: c.kind, version: c.version, textHash: c.text_hash, locale: c.locale })),
    );
    // Local first; the outbox sends consents, then registers the device (devices need consent).
    const outbox = await getOutbox();
    await outbox.enqueue('consent.accept', { request });
    await outbox.enqueue('device.register', {});
    await outbox.enqueue('onboarding.welcome_seen', {});
    kickSync();
    await finishWithDefaults();
    router.replace('/');
  };

  const link = (label: string, doc: 'policy' | 'terms') => (
    <AppText
      variant="footnote"
      color="brand"
      testID={`welcome-policy-link-${doc}`}
      accessibilityRole="link"
      suppressHighlighting
      onPress={() => router.push({ pathname: '/legal', params: { doc } })}
      style={{ fontFamily: theme.type.sectionLabel.fontFamily }}
    >
      {label}
    </AppText>
  );

  return (
    <Screen
      testID="welcome-screen"
      footer={
        <View style={{ gap: theme.space[3] }}>
          <Button testID="welcome-start" label={t('tour.start')} disabled={busy} onPress={() => void begin()} />
          <AppText testID="welcome-policy" variant="footnote" style={styles.center}>
            {t('welcome.policy_before')}
            {link(t('welcome.policy'), 'policy')}
            {t('welcome.policy_and')}
            {link(t('welcome.terms'), 'terms')}
            {t('welcome.policy_after')}
          </AppText>
          {forOther ? (
            <Button testID="welcome-for-other" variant="text" label={t('tour.for_other')} onPress={() => void begin()} />
          ) : null}
        </View>
      }
    >
      <View style={{ gap: theme.space[5], paddingTop: theme.space[4] }}>
        <Illustration />
        <View style={{ gap: theme.space[2] }}>
          <AppText variant="title1" accessibilityRole="header" style={styles.center}>
            {t('welcome.title')}
          </AppText>
          <AppText variant="callout" style={styles.center}>
            {t('welcome.body')}
          </AppText>
        </View>
        <View style={[styles.lang, { maxWidth: theme.largeFont ? undefined : 320 }]}>
          <SegmentedControl<Language>
            testID="welcome-lang"
            accessibilityLabel={t('lang.choose')}
            segments={LANGUAGES.map((l) => ({ key: l, label: t(`lang.${l}`), testID: `lang-${l}` }))}
            value={language}
            onChange={setLanguage}
          />
        </View>
      </View>
    </Screen>
  );
}

/** One picture in the brand colour: the mic on an emerald square with the sun, three things it keeps. */
function Illustration() {
  const theme = useTheme();
  const { t } = useTranslation();
  const chip = (icon: LucideIcon, text: string, sun: boolean, tilt: string) => (
    <Card style={[styles.chip, { transform: [{ rotate: tilt }], paddingVertical: theme.space[2], paddingHorizontal: theme.space[3], gap: theme.space[2] }]}>
      <View style={[styles.dot, { backgroundColor: sun ? theme.colors.highlight : theme.colors.brand }]}>
        <Icon icon={icon} size="sm" color={sun ? 'onHighlight' : 'onBrand'} />
      </View>
      <AppText variant="callout" color="ink" style={{ fontFamily: theme.type.sectionLabel.fontFamily, flexShrink: 1 }}>
        {text}
      </AppText>
    </Card>
  );
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ alignItems: 'center', gap: theme.space[3] }}>
      <View style={[styles.mark, { backgroundColor: theme.colors.brand, borderRadius: 38 }, theme.elevation.floating]}>
        <View style={[styles.sun, { backgroundColor: theme.colors.highlight }]} />
        <Mic size={56} color={theme.colors.onBrand} strokeWidth={theme.icon.strokeWidth} />
      </View>
      {theme.largeFont ? null : (
        <View style={[styles.chips, { gap: theme.space[2] }]}>
          {chip(BellRing, t('welcome.ex_pill'), false, '-3deg')}
          {chip(KeyRound, t('welcome.ex_code'), true, '3deg')}
          {chip(ReceiptText, t('welcome.ex_receipt'), true, '-2deg')}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: 'center' },
  lang: { alignSelf: 'center', width: '100%' },
  mark: { width: 124, height: 124, alignItems: 'center', justifyContent: 'center' },
  sun: { position: 'absolute', right: 16, top: 16, width: 22, height: 22, borderRadius: 11 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
