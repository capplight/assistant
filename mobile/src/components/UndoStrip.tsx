import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { formatShortDate } from '@/records/format';
import { getRecordActions } from '@/services';
import { useToast } from '@/store/toast';
import { UNDO_STRIP_MS, useUndo } from '@/store/undo';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

/** «Уже было — добавил к записи от 12 мар · Отменить»: lives with the assistant line (2-design S37). */
export function UndoStrip() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const strip = useUndo((s) => s.strip);
  const hide = useUndo((s) => s.hide);
  const showToast = useToast((s) => s.show);

  useEffect(() => {
    if (!strip) return;
    const timer = setTimeout(() => hide(strip.id), UNDO_STRIP_MS);
    return () => clearTimeout(timer);
  }, [strip, hide]);

  if (!strip) return null;
  return (
    <View
      testID="undo-strip"
      accessibilityLiveRegion="polite"
      style={[
        styles.row,
        {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.line,
          paddingHorizontal: theme.space[3],
          paddingVertical: theme.space[2],
          gap: theme.space[2],
        },
      ]}
    >
      <AppText variant="meta" color="ink" style={styles.text}>
        {t('dedup.exact', { date: formatShortDate(strip.canonicalDate, i18n.language) })}
      </AppText>
      <Button
        testID="undo-strip-undo"
        label={t('common.undo')}
        variant="text"
        minHeight={theme.size.minTouch}
        onPress={() => {
          hide(strip.id);
          showToast(t('common.undone'));
          void getRecordActions().then((a) => a.unmerge(strip.recordId));
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1 },
  text: { flex: 1 },
});
