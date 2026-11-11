import { router } from 'expo-router';
import { ChevronRight, Mic, PencilLine } from 'lucide-react-native';
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { TemplateCard } from '@/components/TemplateCard';
import { loadStartConfig, notePathChosen, startWithPages } from '@/onboarding/service';
import { TEMPLATES, type TemplateKey } from '@/pages/templates';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { useTheme } from '@/theme';

/**
 * S41 «С чего начнём?» — three paths (Ф-24). The big accent card on top is the team's default
 * (`GET /onboarding` `default_path`, bundled default = path 3 «one phrase»); the other paths are
 * visible on the same screen, one tap each (US-33). A path switched off by the flag is not shown.
 */
export default function StartScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const noAi = useOnboarding(selectNoAi);
  const setPath = useOnboarding((s) => s.setPath);
  const complete = useOnboarding((s) => s.complete);
  const defaultPath = useOnboarding((s) => s.defaultPath);
  const enabled = useOnboarding((s) => s.pathsEnabled);
  const markStartShown = useOnboarding((s) => s.markStartShown);
  useEffect(() => {
    markStartShown();
    // After S05 (GET /onboarding needs the consents); the last answer is kept for offline starts.
    void loadStartConfig();
  }, [markStartShown]);
  const on = (p: 'gallery' | 'blank' | 'phrase_first') => enabled.includes(p) || p === defaultPath;

  const openGallery = (mark?: TemplateKey) => {
    setPath('gallery');
    notePathChosen('gallery');
    router.push({ pathname: '/gallery', params: mark ? { mark } : {} });
  };

  const startBlank = async () => {
    setPath('blank');
    notePathChosen('blank');
    const pages = await startWithPages(['custom'], 'blank');
    complete();
    const first = pages[0];
    if (first) router.replace({ pathname: '/page/[id]', params: { id: first.id } });
    else router.replace('/');
  };

  const MicIcon = noAi ? PencilLine : Mic;

  const phraseCard = (big: boolean) => (
    <Pressable
      testID="start-phrase"
      accessibilityRole="button"
      accessibilityLabel={`${noAi ? t('start.phrase_typed') : t('start.phrase')}. ${t('start.phrase_example')}`}
      onPress={() => {
        setPath('phrase_first');
        notePathChosen('phrase_first');
        router.push('/phrase');
      }}
      style={({ pressed }) => [
        styles.phrase,
        {
          minHeight: big ? 96 : theme.size.primaryTouch,
          backgroundColor: big ? theme.colors.accent : theme.colors.surface,
          borderColor: theme.colors.accent,
          borderWidth: big ? 0 : 2,
          borderRadius: theme.radius.card,
          padding: theme.space[4],
          gap: theme.space[3],
          opacity: pressed ? 0.9 : 1,
        },
      ]}
    >
      <View style={[styles.micCircle, { borderColor: big ? theme.colors.onAccent : theme.colors.accent }]}>
        <MicIcon size={28} color={big ? theme.colors.onAccent : theme.colors.accent} />
      </View>
      <View style={styles.flex}>
        <AppText variant="button" color={big ? 'onAccent' : 'accent'}>
          {noAi ? t('start.phrase_typed') : t('start.phrase')}
        </AppText>
        <AppText variant="meta" color={big ? 'onAccent' : 'ink2'}>
          {t('start.phrase_example')}
        </AppText>
      </View>
    </Pressable>
  );

  const allButton = (big: boolean) => (
    <Pressable
      testID="start-all"
      accessibilityRole="button"
      onPress={() => openGallery()}
      style={[
        styles.all,
        {
          minHeight: big ? 96 : theme.size.primaryTouch,
          marginTop: big ? 0 : theme.space[3],
          borderRadius: theme.radius.button,
          borderColor: theme.colors.accent,
          backgroundColor: big ? theme.colors.accent : 'transparent',
          paddingHorizontal: theme.space[4],
        },
      ]}
    >
      <AppText variant="button" color={big ? 'onAccent' : 'accent'} style={styles.flex}>
        {t('start.all', { n: TEMPLATES.length })}
      </AppText>
      <ChevronRight size={24} color={big ? theme.colors.onAccent : theme.colors.accent} />
    </Pressable>
  );

  let top: ReactNode = null;
  if (defaultPath === 'phrase_first') top = phraseCard(true);
  else if (defaultPath === 'gallery') top = allButton(true);

  return (
    <Screen testID="start-screen">
      <AppText variant="title1" accessibilityRole="header" style={{ marginBottom: theme.space[4] }}>
        {t('start.title')}
      </AppText>

      {top}

      {defaultPath !== 'phrase_first' && on('phrase_first') ? (
        <View style={{ marginTop: top ? theme.space[4] : 0 }}>{phraseCard(false)}</View>
      ) : null}

      <AppText
        variant="section"
        accessibilityRole="header"
        style={{ marginTop: theme.space[8], marginBottom: theme.space[3] }}
      >
        {t('start.or_pages')}
      </AppText>

      <View style={[styles.grid, { gap: theme.space[3], flexDirection: theme.largeFont ? 'column' : 'row' }]}>
        {on('blank') ? (
          <TemplateCard testID="start-blank" templateKey="custom" title={t('start.blank')} onPress={startBlank} />
        ) : null}
        {on('gallery')
          ? (['notes', 'tasks', 'expenses'] as const)
              .slice(0, theme.largeFont ? 1 : 3)
              .map((k) => <TemplateCard key={k} testID={`start-tpl-${k}`} templateKey={k} onPress={() => openGallery(k)} />)
          : null}
      </View>

      {defaultPath !== 'gallery' && on('gallery') ? allButton(false) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  phrase: { flexDirection: 'row', alignItems: 'center' },
  micCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: { flex: 1 },
  grid: { flexWrap: 'wrap' },
  all: { flexDirection: 'row', alignItems: 'center', borderWidth: 2 },
});
