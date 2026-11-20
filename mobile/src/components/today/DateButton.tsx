import { ChevronDown } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { pressedStyle } from '@/components/ui/motion';
import { dateButton, onPlace, useTheme } from '@/theme';

/**
 * today-v6-acceptance.md §3.3 — the date on the yellow sheet as a button: a 32 capsule with an `onSheet` 1.5 outline,
 * «Пт, 20 ноября» 15/600 and a 15 chevron; the target is ≥ 44 high (hitSlop 6 above and below). A tap opens «Другой
 * день». Always today here (the year only for another year — never).
 */
export function DateButton({ label, longLabel, onPress }: { label: string; longLabel: string; onPress: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const c = onPlace(theme.colors, 'today');
  return (
    <View style={{ flexDirection: 'row' }}>
      <Pressable
        testID="today-date"
        accessibilityRole="button"
        accessibilityLabel={t('today6.date_a11y', { date: longLabel })}
        onPress={onPress}
        hitSlop={{ top: dateButton.hitSlop, bottom: dateButton.hitSlop, left: 4, right: 4 }}
        style={({ pressed }) => [
          {
            minHeight: dateButton.height,
            borderRadius: dateButton.radius,
            borderWidth: dateButton.border,
            borderColor: c.ink,
            paddingLeft: 12,
            paddingRight: 10,
            marginLeft: -2,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            flexShrink: 1,
          },
          pressedStyle(pressed),
        ]}
      >
        <AppText
          numberOfLines={1}
          nativeID="v5-capped"
          maxFontSizeMultiplier={1.3}
          style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15, lineHeight: 18, color: c.ink, flexShrink: 1 }}
        >
          {label}
        </AppText>
        <ChevronDown size={dateButton.chevron} color={c.ink} strokeWidth={2} />
      </Pressable>
    </View>
  );
}
