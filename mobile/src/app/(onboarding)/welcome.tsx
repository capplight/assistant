import { router } from 'expo-router';
import { CreditCard, ListChecks, MessageSquareText, StickyNote, Sun } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import type { LucideIcon } from '@/components/ui/Icon';
import { buildConsentRequest, consentScreen } from '@/consent/texts';
import { useConsentTexts } from '@/consent/useConsentTexts';
import { getOutbox } from '@/db';
import { LANGUAGES } from '@/i18n';
import { finishWithDefaults } from '@/onboarding/service';
import { kickSync } from '@/services';
import { getFeatures, useFeatures } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { sheet as sheetV5, useTheme, type PlaceKey } from '@/theme';

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
  const { height } = useWindowDimensions();
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
      color="ink3"
      testID={`welcome-policy-link-${doc}`}
      accessibilityRole="link"
      suppressHighlighting
      onPress={() => router.push({ pathname: '/legal', params: { doc } })}
      style={{ textDecorationLine: 'underline' }}
    >
      {label}
    </AppText>
  );

  // screens-v5 «Приветствие»: the stack of the five places on the tray (the splash and the colours at once), on top the
  // paper sheet with one line about the product, the language and «Начать». Steps shrink on short phones.
  const step = Math.max(28, Math.min(60, Math.round((height * 0.4 - sheetV5.peek) / 5)));
  const paperTop = sheetV5.peek + 5 * step;
  const stack: { place: PlaceKey; icon: LucideIcon; label: string }[] = [
    { place: 'today', icon: Sun, label: t('tpl.short.today') },
    { place: 'notes', icon: StickyNote, label: t('tpl.short.notes') },
    { place: 'assistant', icon: MessageSquareText, label: t('tabs.assistant') },
    { place: 'expenses', icon: CreditCard, label: t('tpl.short.expenses') },
    { place: 'tasks', icon: ListChecks, label: t('tpl.short.tasks') },
  ];
  return (
    <View testID="welcome-screen" style={[styles.flex, { backgroundColor: theme.colors.tray, paddingTop: theme.m.top }]}>
      <View style={styles.flex}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
          {stack.map((x, i) => (
            <View key={x.place} style={[styles.layer, { top: sheetV5.peek + i * step, height: 340, backgroundColor: theme.colors.place[x.place], paddingHorizontal: 22 }]}>
              <x.icon size={22} color={theme.colors.onSheet} strokeWidth={theme.icon.strokeWidth} />
              <AppText numberOfLines={1} style={{ color: theme.colors.onSheet, fontFamily: theme.type.headline.fontFamily, fontSize: 17, lineHeight: 22 }}>
                {x.label}
              </AppText>
            </View>
          ))}
        </View>
        <View style={[styles.paper, { top: paperTop, backgroundColor: theme.colors.paper }]}>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingTop: 26, paddingBottom: Math.max(theme.m.insets.bottom, 16) + 8 }}>
            <AppText variant="title" accessibilityRole="header" style={{ lineHeight: 34 }}>
              {t('welcome.title')}
            </AppText>
            <AppText style={{ fontSize: 17, lineHeight: 25, color: theme.colors.ink2, marginTop: 12 }}>{t('welcome.body')}</AppText>
            <View testID="welcome-lang" accessibilityRole="radiogroup" accessibilityLabel={t('lang.choose')} style={[styles.row, { gap: 8, marginTop: 20, flexWrap: 'wrap' }]}>
              {LANGUAGES.map((l) => (
                <Chip key={l} testID={`lang-${l}`} label={t(`lang.${l}`)} variant={language === l ? 'selected' : 'neutral'} selected={language === l} onPress={() => setLanguage(l)} />
              ))}
            </View>
            <Button testID="welcome-start" label={t('tour.start')} disabled={busy} onPress={() => void begin()} style={{ marginTop: 20 }} />
            <AppText testID="welcome-policy" variant="footnote" style={[styles.center, { marginTop: 12 }]}>
              {t('welcome.policy_before')}
              {link(t('welcome.policy'), 'policy')}
              {t('welcome.policy_and')}
              {link(t('welcome.terms'), 'terms')}
              {t('welcome.policy_after')}
            </AppText>
            {forOther ? <Button testID="welcome-for-other" variant="text" label={t('tour.for_other')} onPress={() => void begin()} /> : null}
          </ScrollView>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { textAlign: 'center' },
  layer: { position: 'absolute', left: 0, right: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, flexDirection: 'row', gap: 10, paddingTop: 13 },
  paper: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
});
