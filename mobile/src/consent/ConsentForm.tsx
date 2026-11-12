import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { CheckRow as Checkbox } from '@/components/ui/Check';
import { Screen } from '@/components/Screen';
import { buildConsentRequest, bundledConsentTextsSync, loadConsentTexts, type ConsentTexts } from './texts';
import { CONSENT_RETENTION_DAYS_PLACEHOLDER } from '@/i18n';
import type { ConsentsIn } from '@/api/types';
import { getApi } from '@/services';
import { useOnboarding, type ConsentRecord } from '@/store/onboarding';
import { useTheme } from '@/theme';

/**
 * S05 — consent before the first phrase (R-03/R-04). DRAFT text for the lawyer (2-design §7.5).
 * Two clearly separated items, all recipients named, 18+ line, «Согласен» and «Без ИИ» equally prominent
 * (both outline, same weight — exception to «one accent button per screen»).
 *
 * Legal texts (checkbox labels, 18+ line, push line, recipients) come from GET /v1/consents/text;
 * offline — from the bundled snapshot of the same server texts. Whatever is on screen when the
 * button is pressed is what gets recorded: exact version + sha256 per kind (POST /v1/consents via
 * the outbox, then POST /v1/devices). Navigation never waits for the network.
 * TODO: {N} days still a placeholder (server text has no retention value yet).
 *
 * Shown on the first launch and again for an account that has no consent of its own.
 */
export function ConsentForm({
  intro,
  footer,
  onAccept,
}: {
  /** Above the title, for the second time. */
  intro?: ReactNode;
  footer?: ReactNode;
  onAccept: (mode: ConsentRecord['mode'], request: ConsentsIn) => Promise<void>;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const language = useOnboarding((s) => s.language);
  // Bundled texts render synchronously (offline-first); server texts replace them when they arrive.
  const [fetched, setFetched] = useState<{ lang: string; texts: ConsentTexts } | null>(null);
  const texts: ConsentTexts = fetched?.lang === language ? fetched.texts : bundledConsentTextsSync(language);
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState(false);
  const [cross, setCross] = useState(false);
  const [showRecipients, setShowRecipients] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadConsentTexts(getApi(), language).then((x) => {
      if (alive && Object.values(x).some((t) => t.source === 'server')) setFetched({ lang: language, texts: x });
    });
    return () => {
      alive = false;
    };
  }, [language]);

  const accept = async (mode: ConsentRecord['mode']) => {
    if (busy) return;
    setBusy(true);
    await onAccept(mode, buildConsentRequest(mode, texts));
  };

  const providers = texts.ai_cross_border.providers.join(', ') || t('consent.recipients');

  const divider = (
    <View style={{ height: 1, backgroundColor: theme.colors.iconSecondary, marginVertical: theme.space[4] }} />
  );
  const link = (label: string) => (
    // TODO: open Terms / Policy / «How the assistant works» full text (2-design §7.5)
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      style={{ minHeight: theme.size.minTouch, justifyContent: 'center' }}
    >
      <AppText color="brand" style={styles.underline}>
        {label}
      </AppText>
    </Pressable>
  );

  return (
    <Screen testID="consent-screen">
      {intro}
      <AppText variant="largeTitle" accessibilityRole="header" style={{ marginBottom: theme.space[5] }}>
        {t('consent.title')}
      </AppText>

      <AppText variant="sectionLabel" accessibilityRole="header">
        {t('consent.storage_title')}
      </AppText>
      <AppText style={{ marginTop: theme.space[2] }}>{t('consent.storage_body')}</AppText>
      <Checkbox testID="consent-storage" label={texts.pd_processing.text} checked={storage} onChange={setStorage} />

      {divider}

      <AppText variant="sectionLabel" accessibilityRole="header">
        {t('consent.cross_title')}
      </AppText>
      <AppText style={{ marginTop: theme.space[2] }}>
        {t('consent.cross_body', { days: CONSENT_RETENTION_DAYS_PLACEHOLDER })}
      </AppText>
      <Pressable
        testID="consent-recipients-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded: showRecipients }}
        onPress={() => setShowRecipients(!showRecipients)}
        style={[styles.row, { minHeight: theme.size.minTouch, gap: theme.space[1] }]}
      >
        {showRecipients ? (
          <ChevronDown size={22} color={theme.colors.brand} />
        ) : (
          <ChevronRight size={22} color={theme.colors.brand} />
        )}
        <AppText color="brand">{t('consent.recipients_toggle')}</AppText>
      </Pressable>
      {/* Recipients are always named on the screen; the toggle only adds the explanation. */}
      <AppText variant="bodyStrong" testID="consent-recipients">
        {providers}
      </AppText>
      {showRecipients ? <AppText variant="callout">{t('consent.recipients_note')}</AppText> : null}
      <AppText variant="callout" style={{ marginTop: theme.space[2] }}>
        {texts.push_content.text}
      </AppText>
      <Checkbox testID="consent-cross" label={texts.ai_cross_border.text} checked={cross} onChange={setCross} />

      {divider}

      <AppText testID="consent-terms">{texts.terms.text}</AppText>
      <View style={[styles.row, styles.wrap, { columnGap: theme.space[4] }]}>
        {link(t('consent.terms'))}
        {link(t('consent.policy'))}
        {link(t('consent.how'))}
      </View>

      <View style={{ gap: theme.space[3], marginTop: theme.space[5] }}>
        <Button
          testID="consent-agree"
          variant="secondary"
          label={t('consent.agree')}
          accessibilityLabel={t('consent.agree_a11y')}
          disabled={!storage || !cross || busy}
          onPress={() => accept('full')}
        />
        <Button
          testID="consent-no-ai"
          variant="secondary"
          label={t('consent.no_ai')}
          accessibilityLabel={t('consent.no_ai_a11y')}
          disabled={!storage || busy}
          onPress={() => accept('no_ai')}
        />
        <AppText variant="callout">{t('consent.no_ai_hint')}</AppText>
        {!storage ? (
          <AppText variant="callout" color="warning" accessibilityLiveRegion="polite">
            {t('consent.need_storage')}
          </AppText>
        ) : null}
        {footer}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  underline: { textDecorationLine: 'underline' },
});
