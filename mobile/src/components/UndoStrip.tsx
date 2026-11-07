import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { formatShortDate } from '@/records/format';
import { getRecordActions } from '@/services';
import { useToast } from '@/store/toast';
import { undoStripMs, useUndo } from '@/store/undo';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

/**
 * «Уже было — добавил к записи от 12 мар · Отменить», «Удалил запись · Отменить»: lives with the
 * assistant line (2-design S37). Stays longer with a large font or a screen reader (2-design 4.3).
 * Not done: «не исчезает, пока на ней фокус», React Native does not report screen reader focus.
 */
export function UndoStrip() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const strip = useUndo((s) => s.strip);
  const hide = useUndo((s) => s.hide);
  const showToast = useToast((s) => s.show);
  const [screenReader, setScreenReader] = useState(false);

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((on) => {
        if (alive) setScreenReader(on);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const durationMs = undoStripMs({ largeFont: theme.largeFont, screenReader });

  useEffect(() => {
    if (!strip) return;
    const timer = setTimeout(() => hide(strip.id), durationMs);
    return () => clearTimeout(timer);
  }, [strip, hide, durationMs]);

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
        {strip.kind === 'merged'
          ? t('dedup.exact', { date: formatShortDate(strip.canonicalDate, i18n.language) })
          : t('record.deleted')}
      </AppText>
      <Button
        testID="undo-strip-undo"
        label={t('common.undo')}
        variant="text"
        minHeight={theme.size.minTouch}
        onPress={() => {
          hide(strip.id);
          showToast(t('common.undone'));
          void getRecordActions().then((a) =>
            strip.kind === 'merged' ? a.unmerge(strip.recordId) : a.restore(strip.recordId),
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1 },
  text: { flex: 1 },
});
