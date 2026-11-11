import { router } from 'expo-router';
import { ChevronLeft, Sun } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { GALLERY_ORDER, getTemplate, type TemplateKey } from '@/pages/templates';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';
import { Screen } from './Screen';
import { TemplateCard } from './TemplateCard';

type Props = {
  /** `phrase`: path 3 after the first result; `gallery`: path 1; `add`: «Готовые страницы» later. */
  mode: 'phrase' | 'gallery' | 'add';
  initial: TemplateKey[];
  /** Topic pages the person has already (add mode: «Уже есть ✓»). */
  existing?: TemplateKey[];
  /** Path 3: «Готово: напомню в пятницу…» above the title. */
  doneLine?: string | null;
  onDone: (keys: TemplateKey[]) => void;
  /** First launch: «Пропустить» = the set shown when the screen opened. */
  onSkip?: () => void;
};

/**
 * S35 «Какие страницы вам нужны?» (R-48, US-23, 2-design 5.2). The whole card is one target
 * (≥160×180), the mark 32 pt; «Сегодня» is shown switched on and cannot be taken off. «Подходит» /
 * «Добавить (N)» works with ≥1 page marked; at ≥150% one column, the button stays at the bottom.
 */
export function Gallery({ mode, initial, existing = [], doneLine, onDone, onSkip }: Props) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [selected, setSelected] = useState<TemplateKey[]>(() => initial.filter((k) => !existing.includes(k)));
  const toggle = (k: TemplateKey) => setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const has = (k: TemplateKey) => existing.includes(k) && getTemplate(k).singleton;
  const n = selected.length;

  return (
    <Screen
      testID="gallery-screen"
      footer={
        <View style={{ gap: theme.space[2] }}>
          {mode !== 'add' ? <AppText variant="meta">{t('gallery.today_fixed')}</AppText> : null}
          <Button
            testID="gallery-ok"
            label={mode === 'add' ? t('gallery.add', { n }) : t('gallery.ok')}
            disabled={n === 0}
            onPress={() => onDone(selected)}
          />
          {onSkip ? (
            <Button testID="gallery-skip" variant="text" label={t('tour.skip')} minHeight={theme.size.minTouch} onPress={onSkip} />
          ) : null}
        </View>
      }
    >
      {mode !== 'phrase' ? (
        <Pressable
          testID="gallery-back"
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          onPress={() => router.back()}
          style={[styles.back, { minHeight: theme.size.minTouch }]}
        >
          <ChevronLeft size={24} color={theme.colors.accent} />
          <AppText color="accent">{t('common.back')}</AppText>
        </Pressable>
      ) : doneLine ? (
        <AppText testID="gallery-done-line" color="done" style={{ marginBottom: theme.space[2] }}>
          {doneLine}
        </AppText>
      ) : null}
      <AppText variant="title1" accessibilityRole="header">
        {t('gallery.title')}
      </AppText>
      <AppText color="ink2" style={{ marginBottom: theme.space[4] }}>
        {mode === 'phrase' ? t('gallery.premarked') : t('gallery.hint')}
      </AppText>

      <View
        testID="gallery-today"
        accessible
        accessibilityRole="checkbox"
        accessibilityState={{ checked: true, disabled: true }}
        accessibilityLabel={`${t('tpl.today')}. ${t('gallery.today_always')}`}
        style={[
          styles.today,
          {
            minHeight: theme.size.primaryTouch,
            gap: theme.space[3],
            padding: theme.space[3],
            marginBottom: theme.space[3],
            borderRadius: theme.radius.card,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.surface,
          },
        ]}
      >
        <Sun size={theme.size.cardIcon} color={theme.colors.ink} />
        <View style={styles.flex}>
          <AppText variant="title2">{t('tpl.today')}</AppText>
          <AppText variant="meta">{t('gallery.today_always')}</AppText>
        </View>
        <AppText variant="bodyStrong" color="ink2">
          ✓
        </AppText>
      </View>

      <View style={[styles.grid, { gap: theme.space[3], flexDirection: theme.largeFont ? 'column' : 'row' }]}>
        {GALLERY_ORDER.map((k) => (
          <TemplateCard
            key={k}
            testID={`gallery-${k}`}
            templateKey={k}
            exists={has(k)}
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
  today: { flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  flex: { flex: 1 },
});
