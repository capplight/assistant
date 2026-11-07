import { router } from 'expo-router';
import { ChevronRight, Mic, PencilLine } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { TemplateCard } from '@/components/TemplateCard';
import { saveNewPages } from '@/pages/service';
import { TEMPLATES, type TemplateKey } from '@/pages/templates';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { useTheme } from '@/theme';

/**
 * S41 «С чего начнём?» — three paths (Ф-24). Default = path 3 «one phrase» (accent, first in order,
 * gets focus first); paths 1 (gallery) and 2 (blank page) are visible on the same screen.
 */
export default function StartScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const noAi = useOnboarding(selectNoAi);
  const setPath = useOnboarding((s) => s.setPath);
  const complete = useOnboarding((s) => s.complete);
  const createFromOnboarding = usePages((s) => s.createFromOnboarding);

  const openGallery = (mark?: TemplateKey) => {
    setPath('gallery');
    router.push({ pathname: '/gallery', params: mark ? { mark } : {} });
  };

  const startBlank = async () => {
    setPath('blank');
    const pages = createFromOnboarding(['custom'], 'onboarding_blank');
    await saveNewPages(pages);
    complete();
    const first = pages[0];
    if (first) router.replace({ pathname: '/page/[id]', params: { id: first.id } });
    else router.replace('/');
  };

  const MicIcon = noAi ? PencilLine : Mic;

  return (
    <Screen testID="start-screen">
      <AppText variant="title1" accessibilityRole="header" style={{ marginBottom: theme.space[4] }}>
        {t('start.title')}
      </AppText>

      <Pressable
        testID="start-phrase"
        accessibilityRole="button"
        accessibilityLabel={`${noAi ? t('start.phrase_typed') : t('start.phrase')}. ${t('start.phrase_example')}`}
        onPress={() => {
          setPath('phrase_first');
          router.push('/phrase');
        }}
        style={({ pressed }) => [
          styles.phrase,
          {
            minHeight: 96,
            backgroundColor: theme.colors.accent,
            borderRadius: theme.radius.card,
            padding: theme.space[4],
            gap: theme.space[3],
            opacity: pressed ? 0.9 : 1,
          },
        ]}
      >
        <View style={[styles.micCircle, { borderColor: theme.colors.onAccent }]}>
          <MicIcon size={28} color={theme.colors.onAccent} />
        </View>
        <View style={styles.flex}>
          <AppText variant="button" color="onAccent">
            {noAi ? t('start.phrase_typed') : t('start.phrase')}
          </AppText>
          <AppText variant="meta" color="onAccent">
            {t('start.phrase_example')}
          </AppText>
        </View>
      </Pressable>

      <AppText
        variant="section"
        accessibilityRole="header"
        style={{ marginTop: theme.space[8], marginBottom: theme.space[3] }}
      >
        {t('start.or_pages')}
      </AppText>

      <View style={[styles.grid, { gap: theme.space[3], flexDirection: theme.largeFont ? 'column' : 'row' }]}>
        <TemplateCard testID="start-blank" templateKey="custom" title={t('start.blank')} onPress={startBlank} />
        {(['notes', 'tasks', 'expenses'] as const).slice(0, theme.largeFont ? 1 : 3).map((k) => (
          <TemplateCard key={k} testID={`start-tpl-${k}`} templateKey={k} onPress={() => openGallery(k)} />
        ))}
      </View>

      <Pressable
        testID="start-all"
        accessibilityRole="button"
        onPress={() => openGallery()}
        style={[
          styles.all,
          {
            minHeight: theme.size.primaryTouch,
            marginTop: theme.space[3],
            borderRadius: theme.radius.button,
            borderColor: theme.colors.accent,
            paddingHorizontal: theme.space[4],
          },
        ]}
      >
        <AppText variant="button" color="accent" style={styles.flex}>
          {t('start.all', { n: TEMPLATES.length })}
        </AppText>
        <ChevronRight size={24} color={theme.colors.accent} />
      </Pressable>
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
