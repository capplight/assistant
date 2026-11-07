import { router } from 'expo-router';
import { UserRound } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { useOnboarding } from '@/store/onboarding';
import { useTheme } from '@/theme';

/**
 * S06 «Сегодня» — system page, always first, cannot be removed (R-49).
 * Week 1: empty state only. TODO(week 9): alarms, missed, «Я сделал за вас», suggestions, waiting answers.
 */
export default function TodayScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const name = useOnboarding((s) => s.displayName);
  let date: string;
  try {
    date = new Date().toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    date = new Date().toDateString();
  }
  return (
    <Screen testID="page-today" edges={['top']}>
      <View style={styles.header}>
        <AppText variant="meta" style={styles.flex}>
          {date}
        </AppText>
        <Pressable
          testID="today-profile"
          accessibilityRole="button"
          accessibilityLabel={t('today.profile')}
          onPress={() => router.navigate('/more')}
          style={[
            styles.avatar,
            {
              width: theme.size.minTouch,
              height: theme.size.minTouch,
              borderRadius: theme.radius.round,
              borderColor: theme.colors.lineStrong,
            },
          ]}
        >
          <UserRound size={24} color={theme.colors.ink} />
        </Pressable>
      </View>
      <AppText variant="display" accessibilityRole="header" style={{ marginBottom: theme.space[8] }}>
        {name ? t('today.hello_name', { name }) : t('today.hello')}
      </AppText>
      <AppText variant="section" accessibilityRole="header" style={{ marginBottom: theme.space[3] }}>
        {t('today.today')}
      </AppText>
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.line,
          borderWidth: 1,
          borderRadius: theme.radius.card,
          padding: theme.space[4],
        }}
      >
        <AppText>{t('today.empty')}</AppText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  flex: { flex: 1 },
  avatar: { borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
