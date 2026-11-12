import { router } from 'expo-router';
import { Camera, FileText, Mic, Search, Wallet } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { MiniSchema } from '@/components/MiniSchema';
import { Screen } from '@/components/Screen';
import { LANGUAGES } from '@/i18n';
import { TOUR_INTERESTS, useOnboarding, type TourInterest } from '@/store/onboarding';
import { useTheme } from '@/theme';

const FRAMES = 3;

const INTEREST_ICON = { voice: Mic, photo: Camera, find: Search, kp: FileText, money: Wallet } as const;
const INTEREST_KEY: Record<TourInterest, string> = {
  voice: 'tour.can_voice',
  photo: 'tour.can_photo',
  find: 'tour.can_find',
  kp: 'tour.can_kp',
  money: 'tour.can_money',
};

/** S01–S02 — three frames, advance only by button (no auto-play), «Пропустить» on each (Ф-24). */
export default function WelcomeScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const [frame, setFrame] = useState(0);
  const { language, setLanguage, interests, toggleInterest, markWelcomeSeen, markOpened } = useOnboarding();
  useEffect(() => {
    markOpened(); // US-14 criterion A starts here
  }, [markOpened]);

  const finish = (skipped: boolean) => {
    markWelcomeSeen(skipped);
    router.replace('/consent');
  };

  const last = frame === FRAMES - 1;

  return (
    <Screen
      testID={`welcome-frame-${frame + 1}`}
      footer={
        <View style={{ gap: theme.space[3] }}>
          <View style={styles.dotsRow} accessible accessibilityLabel={t('tour.step', { n: frame + 1, total: FRAMES })}>
            {Array.from({ length: FRAMES }, (_, i) => (
              <View
                key={i}
                style={[styles.dot, { backgroundColor: i === frame ? theme.colors.brand : theme.colors.iconSecondary }]}
              />
            ))}
            <AppText variant="callout" style={{ marginLeft: theme.space[2] }}>
              {t('tour.step', { n: frame + 1, total: FRAMES })}
            </AppText>
          </View>
          <Button
            testID="welcome-next"
            label={last ? t('tour.start') : t('tour.next')}
            onPress={() => (last ? finish(false) : setFrame(frame + 1))}
          />
        </View>
      }
    >
      <View style={styles.skipRow}>
        <Button
          testID="welcome-skip"
          variant="text"
          minHeight={theme.size.minTouch}
          label={t('tour.skip')}
          onPress={() => finish(true)}
        />
      </View>

      {frame === 0 && (
        <View style={{ gap: theme.space[5] }}>
          <View style={styles.sheets} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {[0, 1, 2].map((i) => (
              <View
                key={i}
                style={{
                  width: 64,
                  height: 80,
                  marginLeft: i === 0 ? 0 : -24,
                  marginTop: i * 6,
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.separator,
                  borderWidth: 1,
                  borderRadius: theme.radius.lg,
                }}
              />
            ))}
          </View>
          <AppText variant="largeTitle" accessibilityRole="header">
            {t('tour.welcome')}
          </AppText>
          <AppText>{t('tour.title')}</AppText>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t('lang.choose')}
            style={[styles.segment, { gap: theme.space[2] }]}
          >
            {LANGUAGES.map((lang) => {
              const selected = lang === language;
              return (
                <Pressable
                  key={lang}
                  testID={`lang-${lang}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLanguage={lang}
                  onPress={() => setLanguage(lang)}
                  style={[
                    styles.segmentItem,
                    {
                      minHeight: theme.size.buttonHeight,
                      borderRadius: theme.radius.md,
                      borderWidth: 2,
                      borderColor: selected ? theme.colors.brand : theme.colors.iconSecondary,
                      backgroundColor: selected ? theme.colors.surface : 'transparent',
                    },
                  ]}
                >
                  <AppText variant={selected ? 'bodyStrong' : 'body'} color={selected ? 'brand' : 'ink'}>
                    {selected ? '● ' : ''}
                    {t(`lang.${lang}`)}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
          {/* TODO: «Настраиваю для другого человека» flow (helper mode) — later week. */}
          <Button
            variant="text"
            label={t('tour.for_other')}
            minHeight={theme.size.minTouch}
            onPress={() => setFrame(1)}
          />
        </View>
      )}

      {frame === 1 && (
        <View style={{ gap: theme.space[3] }}>
          <AppText variant="largeTitle" accessibilityRole="header">
            {t('tour.ask')}
          </AppText>
          {TOUR_INTERESTS.map((key) => {
            const Icon = INTEREST_ICON[key];
            const checked = interests.includes(key);
            return (
              <Pressable
                key={key}
                testID={`interest-${key}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                accessibilityLabel={t(INTEREST_KEY[key])}
                onPress={() => toggleInterest(key)}
                style={[
                  styles.interest,
                  {
                    minHeight: theme.size.buttonHeight,
                    gap: theme.space[3],
                    borderRadius: theme.radius.lg,
                    borderWidth: 1,
                    borderColor: checked ? theme.colors.brand : theme.colors.separator,
                    backgroundColor: theme.colors.surface,
                    padding: theme.space[3],
                  },
                ]}
              >
                <Icon size={theme.size.icon} color={theme.colors.ink} strokeWidth={2} />
                <AppText style={styles.flex}>{t(INTEREST_KEY[key])}</AppText>
                <AppText variant="bodyStrong" color="brand">
                  {checked ? '☑' : '☐'}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      )}

      {frame === 2 && (
        <View style={{ gap: theme.space[4] }}>
          <AppText variant="largeTitle" accessibilityRole="header">
            {t('tour.pages_title')}
          </AppText>
          <View style={[styles.row, { gap: theme.space[2], flexWrap: 'wrap' }]}>
            {(['notes', 'tasks', 'expenses'] as const).map((k) => (
              <View
                key={k}
                style={[
                  styles.miniCard,
                  {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.separator,
                    borderRadius: theme.radius.lg,
                    padding: theme.space[3],
                  },
                ]}
              >
                <MiniSchema kind={k} />
                <AppText variant="callout" color="ink">
                  {t(`tpl.short.${k}`)}
                </AppText>
              </View>
            ))}
          </View>
          <AppText>{t('tour.pages')}</AppText>
          <View
            accessible
            accessibilityLabel={t('tour.demo_result_a11y')}
            style={{
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.separator,
              borderWidth: 1,
              borderRadius: theme.radius.lg,
              padding: theme.space[4],
            }}
          >
            <AppText>{t('tour.demo_result')}</AppText>
            <AppText variant="callout" style={styles.right}>
              {t('tour.example')}
            </AppText>
          </View>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  skipRow: { alignItems: 'flex-end' },
  sheets: { flexDirection: 'row', height: 100 },
  segment: { flexDirection: 'row', flexWrap: 'wrap' },
  segmentItem: { flexGrow: 1, flexBasis: 140, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  interest: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  row: { flexDirection: 'row' },
  miniCard: { borderWidth: 1, flexGrow: 1, flexBasis: 90 },
  dotsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  right: { textAlign: 'right' },
});
