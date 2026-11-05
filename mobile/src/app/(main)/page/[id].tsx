import { useLocalSearchParams } from 'expo-router';
import { Search } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { TextInput, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { PageIcon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { usePageLabels } from '@/pages/usePageLabels';
import { usePages } from '@/store/pages';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

/**
 * S37 — universal page rendered from its template. Week 1: header, «Найти на странице» (stub) and
 * empty state. TODO(week 3): items from local DB, layouts list/checklist/table/builtin:*.
 */
export default function PageScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const page = usePages((s) => s.pages.find((p) => p.id === id));
  const { title } = usePageLabels();

  if (!page) {
    return (
      <Screen testID="page-missing" edges={['top']}>
        <AppText variant="title1">{t('page.not_found')}</AppText>
      </Screen>
    );
  }

  return (
    <Screen testID={`page-${page.templateKey}`} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3], marginBottom: theme.space[4] }}>
        <PageIcon name={page.icon} color={theme.colors.ink} size={28} />
        <AppText variant="title1" accessibilityRole="header" style={{ flex: 1 }}>
          {title(page)}
        </AppText>
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[2],
          minHeight: theme.size.minTouch,
          borderWidth: 1,
          borderColor: theme.colors.lineStrong,
          borderRadius: theme.radius.input,
          paddingHorizontal: theme.space[3],
          backgroundColor: theme.colors.surface,
          marginBottom: theme.space[6],
        }}
      >
        <Search size={22} color={theme.colors.ink2} />
        <TextInput
          testID="page-find"
          accessibilityLabel={t('page.find')}
          placeholder={t('page.find')}
          placeholderTextColor={theme.colors.ink2}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[theme.type.body, { flex: 1, color: theme.colors.ink, minHeight: theme.size.minTouch }]}
        />
      </View>
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.line,
          borderWidth: 1,
          borderRadius: theme.radius.card,
          padding: theme.space[4],
          gap: theme.space[2],
        }}
      >
        <AppText>{t('page.empty')}</AppText>
        <AppText variant="meta">{t(`tpl.line_hint.${page.templateKey}`)}</AppText>
      </View>
    </Screen>
  );
}
