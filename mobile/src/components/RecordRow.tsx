import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { LocalRecord } from '@/db';
import { recordTitle, sourceLine, statusLine } from '@/records/format';
import { unverifiedCount } from '@/records/review';
import { useTheme } from '@/theme';

import { AppText } from './AppText';

/** One record in a list (S37 «Последние»). The whole card opens S09. */
export function RecordRow({
  record,
  onPress,
  snippet,
}: {
  record: LocalRecord;
  onPress: () => void;
  /** Search: the place that matched, when the title does not show it. */
  snippet?: string | null;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const title = recordTitle(record, t);
  const source = sourceLine(record, i18n.language, t);
  const status = statusLine(record, t);
  const toCheck = unverifiedCount(record) > 0;
  return (
    <Pressable
      testID={`record-${record.id}`}
      accessibilityRole="button"
      accessibilityLabel={[title, source, status, toCheck ? t('check.badge') : null].filter(Boolean).join('. ')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.line,
          borderRadius: theme.radius.card,
          padding: theme.space[4],
          marginBottom: theme.space[3],
          minHeight: theme.size.primaryTouch,
          gap: theme.space[1],
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <AppText numberOfLines={3}>{title}</AppText>
      {snippet && snippet !== title ? <AppText variant="meta">{snippet}</AppText> : null}
      <AppText variant="meta">{source}</AppText>
      {status ? <AppText variant="meta">{status}</AppText> : null}
      {record.aiGenerated ? <AppText variant="meta">{t('ai.label_short')}</AppText> : null}
      {toCheck ? (
        <View
          testID={`record-check-${record.id}`}
          style={[
            styles.badge,
            {
              backgroundColor: theme.colors.markerSoft,
              borderRadius: theme.radius.chip,
              paddingHorizontal: theme.space[2],
            },
          ]}
        >
          <AppText variant="meta" color="warnText">
            {t('check.badge')}
          </AppText>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1 },
  badge: { alignSelf: 'flex-start' },
});
