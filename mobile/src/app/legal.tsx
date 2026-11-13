import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { Card } from '@/components/ui/Card';
import { Header } from '@/components/ui/Header';
import { useConsentTexts } from '@/consent/useConsentTexts';
import { CONSENT_RETENTION_DAYS_PLACEHOLDER } from '@/i18n';
import { useOnboarding } from '@/store/onboarding';
import { useTheme } from '@/theme';

type Doc = 'policy' | 'terms' | 'consents';

/**
 * The texts «Начать» accepts (Ф-34) and what was recorded: `doc=policy` — storage in Kazakhstan and the
 * cross-border transfer to the named AI services (the «ИИ» disclosure lives here), `doc=terms` — the terms and
 * the 18+ line, `doc=consents` — «Настройки → Согласия»: what this phone accepted, versions and when.
 * The same texts and versions as `GET /v1/consents/text` (bundled snapshot offline). DRAFT wording for the lawyer.
 */
export default function LegalScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const params = useLocalSearchParams<{ doc?: string }>();
  const doc: Doc = params.doc === 'terms' || params.doc === 'consents' ? params.doc : 'policy';
  const language = useOnboarding((s) => s.language);
  const consent = useOnboarding((s) => s.consent);
  const texts = useConsentTexts(language);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const title = { policy: t('legal.policy'), terms: t('legal.terms'), consents: t('legal.consents') }[doc];

  const block = (heading: string, body: string[], version?: string, testID?: string) => (
    <Card testID={testID} style={{ gap: theme.space[2] }}>
      <AppText variant="headline" accessibilityRole="header">
        {heading}
      </AppText>
      {body.map((b, i) => (
        <AppText key={i}>{b}</AppText>
      ))}
      {version ? <AppText variant="footnote">{t('legal.version', { v: version })}</AppText> : null}
    </Card>
  );

  let content;
  if (doc === 'policy') {
    content = (
      <>
        {block(t('consent.storage_title'), [t('consent.storage_body'), texts.pd_processing.text], texts.pd_processing.version, 'legal-pd')}
        {block(
          t('consent.cross_title'),
          [t('consent.cross_body', { days: CONSENT_RETENTION_DAYS_PLACEHOLDER }), texts.ai_cross_border.text, texts.ai_cross_border.providers.join(', ') || t('consent.recipients')],
          texts.ai_cross_border.version,
          'legal-ai',
        )}
        {block(t('legal.push_title'), [texts.push_content.text], texts.push_content.version)}
      </>
    );
  } else if (doc === 'terms') {
    content = block(t('legal.terms'), [texts.terms.text], texts.terms.version, 'legal-terms');
  } else {
    let when = '';
    if (consent) {
      try {
        when = new Date(consent.acceptedAt).toLocaleString(i18n.language, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      } catch {
        when = consent.acceptedAt;
      }
    }
    content = consent ? (
      <>
        {block(
          consent.mode === 'full' ? t('consent.mode_full') : t('consent.mode_no_ai'),
          [t('legal.accepted_at', { when })],
          undefined,
          'legal-consent-mode',
        )}
        {consent.texts.length > 0
          ? block(
              t('legal.versions'),
              consent.texts.map((x) => `${t(`consent.kind.${x.kind}`, { defaultValue: x.kind })}: ${x.version}`),
            )
          : null}
      </>
    ) : (
      <AppText color="ink2">{t('legal.none')}</AppText>
    );
  }

  return (
    <Screen testID={`legal-${doc}`}>
      <Header title={title} back={{ onPress: back }} />
      <View style={{ gap: theme.space[3] }}>{content}</View>
    </Screen>
  );
}
