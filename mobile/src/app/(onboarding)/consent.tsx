import { router } from 'expo-router';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Checkbox } from '@/components/Checkbox';
import { Screen } from '@/components/Screen';
import { getOutbox } from '@/db';
import { CONSENT_RETENTION_DAYS_PLACEHOLDER } from '@/i18n';
import { useOnboarding, type ConsentRecord } from '@/store/onboarding';
import { useTheme } from '@/theme';

/**
 * S05 — consent before the first phrase (R-03/R-04). DRAFT text for the lawyer (2-design §7.5).
 * Two clearly separated items, all recipients named, 18+ line, «Согласен» and «Без ИИ» equally prominent
 * (both outline, same weight — exception to «one accent button per screen»).
 * TODO(week 1 backend): text, recipients list, {N}, version and hash come from GET /consents/text.
 */
export default function ConsentScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const acceptConsent = useOnboarding((s) => s.acceptConsent);
  const [storage, setStorage] = useState(false);
  const [cross, setCross] = useState(false);
  const [showRecipients, setShowRecipients] = useState(false);

  const accept = async (mode: ConsentRecord['mode']) => {
    acceptConsent(mode);
    const consent = useOnboarding.getState().consent;
    // Recorded locally first; the backend receives it via the outbox (no sync in week 1).
    const outbox = await getOutbox();
    await outbox.enqueue('consent.accept', consent);
    router.replace('/start');
  };

  const divider = (
    <View style={{ height: 1, backgroundColor: theme.colors.lineStrong, marginVertical: theme.space[4] }} />
  );
  const link = (label: string) => (
    // TODO: open Terms / Policy / «How the assistant works» full text (2-design §7.5)
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      style={{ minHeight: theme.size.minTouch, justifyContent: 'center' }}
    >
      <AppText color="accent" style={styles.underline}>
        {label}
      </AppText>
    </Pressable>
  );

  return (
    <Screen testID="consent-screen">
      <AppText variant="title1" accessibilityRole="header" style={{ marginBottom: theme.space[5] }}>
        {t('consent.title')}
      </AppText>

      <AppText variant="section" accessibilityRole="header">
        {t('consent.storage_title')}
      </AppText>
      <AppText style={{ marginTop: theme.space[2] }}>{t('consent.storage_body')}</AppText>
      <Checkbox testID="consent-storage" label={t('consent.storage_check')} checked={storage} onChange={setStorage} />

      {divider}

      <AppText variant="section" accessibilityRole="header">
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
          <ChevronDown size={22} color={theme.colors.accent} />
        ) : (
          <ChevronRight size={22} color={theme.colors.accent} />
        )}
        <AppText color="accent">{t('consent.recipients_toggle')}</AppText>
      </Pressable>
      {/* Recipients are always named on the screen; the toggle only adds the explanation. */}
      <AppText variant="bodyStrong" testID="consent-recipients">
        {t('consent.recipients')}
      </AppText>
      {showRecipients ? <AppText variant="meta">{t('consent.recipients_note')}</AppText> : null}
      <AppText variant="meta" style={{ marginTop: theme.space[2] }}>
        {t('consent.push_line')}
      </AppText>
      <Checkbox testID="consent-cross" label={t('consent.cross_check')} checked={cross} onChange={setCross} />

      {divider}

      <AppText>{t('consent.age')}</AppText>
      <View style={[styles.row, styles.wrap, { columnGap: theme.space[4] }]}>
        {link(t('consent.terms'))}
        {link(t('consent.policy'))}
        {link(t('consent.how'))}
      </View>

      <View style={{ gap: theme.space[3], marginTop: theme.space[5] }}>
        <Button
          testID="consent-agree"
          variant="outline"
          label={t('consent.agree')}
          accessibilityLabel={t('consent.agree_a11y')}
          disabled={!storage || !cross}
          onPress={() => accept('full')}
        />
        <Button
          testID="consent-no-ai"
          variant="outline"
          label={t('consent.no_ai')}
          accessibilityLabel={t('consent.no_ai_a11y')}
          disabled={!storage}
          onPress={() => accept('no_ai')}
        />
        <AppText variant="meta">{t('consent.no_ai_hint')}</AppText>
        {!storage ? (
          <AppText variant="meta" color="warnText" accessibilityLiveRegion="polite">
            {t('consent.need_storage')}
          </AppText>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  underline: { textDecorationLine: 'underline' },
});
