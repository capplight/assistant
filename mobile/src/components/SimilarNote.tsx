import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { visibleGroups } from '@/dedup/service';
import { useDedup } from '@/dedup/store';
import { formatShortDate } from '@/records/format';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';

/**
 * S09: «Похоже на запись от 12 окт. Объединить?» (2-design 7, string 26) when the record is in a
 * group waiting for a decision. Nothing is merged here: [Посмотреть] opens S26, where the person
 * says «Да» for that group.
 */
export function SimilarNote({ serverId }: { serverId: string | null }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const src = useDedup(useShallow((s) => ({ groups: s.groups, decided: s.decided })));
  if (!serverId) return null;
  const group = visibleGroups(src.groups, src.decided).find((g) => g.members.some((m) => m.item_id === serverId));
  const other = group?.members.find((m) => m.item_id !== serverId);
  if (!group || !other) return null;
  const iso = other.occurred_at ?? other.created_at;
  return (
    <View testID="record-similar" style={{ gap: theme.space[1], marginVertical: theme.space[2] }}>
      <AppText>{t('dedup.similar', { date: iso ? formatShortDate(iso, i18n.language) : '' })}</AppText>
      <Button
        testID="record-similar-open"
        label={t('dup.look')}
        accessibilityLabel={t('dup.look_a11y')}
        variant="secondary"
        minHeight={theme.size.minTouch}
        onPress={() => router.push('/duplicates')}
      />
    </View>
  );
}
