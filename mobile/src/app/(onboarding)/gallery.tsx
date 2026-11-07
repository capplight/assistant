import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { TemplateCard } from '@/components/TemplateCard';
import { saveNewPages } from '@/pages/service';
import { DEFAULT_PREMARKED, GALLERY_ORDER, TEMPLATES, type TemplateKey } from '@/pages/templates';
import { useSavedLine } from '@/store/connectivity';
import { premarksFor, useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { useTheme } from '@/theme';

const isTemplateKey = (s: string): s is TemplateKey => TEMPLATES.some((t) => t.key === s);

/**
 * S35 — template gallery in the first launch (R-48, US-23).
 * from=phrase (path 3): Notes + Tasks premarked (+ Documents / Expenses from the phrase and welcome picks).
 * Otherwise (path 1): only the tapped card (if any) + welcome picks.
 * «Подходит» creates local pages; the server gets them via outbox (one POST /pages per page).
 */
export default function GalleryScreen() {
  const savedLine = useSavedLine();
  const theme = useTheme();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ mark?: string; from?: string }>();
  const fromPhrase = params.from === 'phrase';
  const interests = useOnboarding((s) => s.interests);
  const complete = useOnboarding((s) => s.complete);
  const createFromOnboarding = usePages((s) => s.createFromOnboarding);

  const [selected, setSelected] = useState<TemplateKey[]>(() => {
    const marks = (params.mark ?? '').split(',').filter(isTemplateKey);
    return premarksFor(interests, fromPhrase ? [...DEFAULT_PREMARKED, ...marks] : marks);
  });

  const toggle = (k: TemplateKey) => setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  const confirm = async () => {
    // Tab order follows the catalog order, not the tap order.
    const keys = TEMPLATES.map((tpl) => tpl.key).filter((k) => selected.includes(k));
    const pages = createFromOnboarding(keys, fromPhrase ? 'onboarding_phrase' : 'onboarding_gallery');
    await saveNewPages(pages);
    complete();
    // Path 1: open the first chosen page (S04b comes after the first saved record).
    // Path 3: the first result exists already, so S04b now, then «Сегодня».
    if (fromPhrase) router.replace({ pathname: '/phone', params: { next: 'home' } });
    else if (pages[0]) router.replace({ pathname: '/page/[id]', params: { id: pages[0].id } });
    else router.replace('/');
  };

  return (
    <Screen
      testID="gallery-screen"
      footer={
        <View style={{ gap: theme.space[2] }}>
          <AppText variant="meta">{t('gallery.today_fixed')}</AppText>
          <Button testID="gallery-ok" label={t('gallery.ok')} onPress={confirm} />
        </View>
      }
    >
      {!fromPhrase ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          onPress={() => router.back()}
          style={[styles.back, { minHeight: theme.size.minTouch }]}
        >
          <ChevronLeft size={24} color={theme.colors.accent} />
          <AppText color="accent">{t('common.back')}</AppText>
        </Pressable>
      ) : (
        <AppText color="done" style={{ marginBottom: theme.space[2] }}>
          {savedLine}
        </AppText>
      )}
      <AppText variant="title1" accessibilityRole="header">
        {t('gallery.title')}
      </AppText>
      <AppText color="ink2" style={{ marginBottom: theme.space[4] }}>
        {fromPhrase ? t('gallery.premarked') : t('gallery.hint')}
      </AppText>
      <View style={[styles.grid, { gap: theme.space[3], flexDirection: theme.largeFont ? 'column' : 'row' }]}>
        {GALLERY_ORDER.map((k) => (
          <TemplateCard
            key={k}
            testID={`gallery-${k}`}
            templateKey={k}
            checked={selected.includes(k)}
            onPress={() => toggle(k)}
          />
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  grid: { flexWrap: 'wrap' },
});
