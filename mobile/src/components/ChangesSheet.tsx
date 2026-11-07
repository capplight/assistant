import { useTranslation } from 'react-i18next';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { revertChange } from '@/chat/service';
import type { ChatMessage } from '@/store/assistant';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

/**
 * «Что изменилось» (2-design 6.9): one line per record, ««Плитка, замер» → Ремонт» (ready text
 * from the server, plain text), each with [Вернуть]; [Отменить всё] at the bottom.
 */
export function ChangesSheet({
  message,
  onClose,
  onUndoAll,
}: {
  message: ChatMessage | null;
  onClose: () => void;
  onUndoAll: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const action = message?.action;
  const open = !!message && !!action;
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID="changes-sheet"
          style={[
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.sheet,
              borderTopRightRadius: theme.radius.sheet,
              maxHeight: '85%',
            },
            theme.elevation?.sheet,
          ]}
        >
          <ScrollView contentContainerStyle={{ padding: theme.space[5], gap: theme.space[3] }}>
            <AppText variant="title2" accessibilityRole="header">
              {t('line.changed')}
            </AppText>
            {action?.changes.map((c) => {
              const what = c.title ?? t('answer.source');
              const line = c.text || what;
              const off = !!c.reverted || !!action.undone || !action.undoable;
              return (
                <View
                  key={c.itemId}
                  testID={`change-${c.itemId}`}
                  style={[styles.row, { gap: theme.space[2], borderBottomColor: theme.colors.line, paddingBottom: theme.space[2] }]}
                >
                  <AppText style={styles.flex}>{line}</AppText>
                  {c.reverted ? (
                    <AppText variant="meta">{t('changes.reverted')}</AppText>
                  ) : (
                    <Button
                      testID={`change-revert-${c.itemId}`}
                      label={t('changes.revert')}
                      accessibilityLabel={t('changes.revert_a11y', { what })}
                      variant="text"
                      disabled={off}
                      minHeight={theme.size.minTouch}
                      onPress={() => message && void revertChange(message.id, c.itemId)}
                    />
                  )}
                </View>
              );
            })}
            {action && action.undoable && !action.undone ? (
              <Button testID="changes-undo-all" label={t('changes.undo_all')} variant="outline" onPress={onUndoAll} />
            ) : null}
            <Button testID="changes-close" label={t('common.close')} variant="text" onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1 },
  flex: { flex: 1 },
});
