import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useChrome } from '@/store/chrome';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';

/** An item of the template on top of the shared menu (≤2: Цвет · Приколоть, Категория…). */
export type MenuExtra = { testID: string; label: string; onPress: () => void; hint?: string };

/**
 * «⋯ Ещё» of a record on a page (2-design 4.7 п. 2, S39 step 1): «Выше» / «Ниже» (they do not
 * close the sheet, press again and again), «Переместить на страницу…», «Показать ещё на…»,
 * «Убрать с этой страницы», «Удалить» at the bottom. Rows 56 pt. Not here yet: «Положить в
 * стопку…» (stacks) and «Изменить» (the card has «Исправить»).
 */
export function RecordMenuSheet({
  title,
  mine,
  canUp,
  canDown,
  onUp,
  onDown,
  onMoveTo,
  onAlso,
  onRemove,
  onDelete,
  onClose,
  extra,
  move,
  onDocument,
}: {
  title: string;
  /** «Вы поставили эту запись сюда сами». */
  mine: boolean;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  onMoveTo: () => void;
  onAlso: () => void;
  onRemove: () => void;
  onDelete: () => void;
  onClose: () => void;
  /** Template-screens 3: the template's own items go first, the shared ones stay where they are. */
  extra?: MenuExtra[];
  /**
   * Weeks 16а–16б, «Доска»: «Подвинуть» stands where «Выше / Ниже» stand (on the free board a
   * sticker moves in four directions, in its own sheet).
   */
  move?: MenuExtra;
  /** Ф-51: «Сделать документ из этого» on a file the client sent (a КП from the ТЗ). */
  onDocument?: () => void;
}) {
  const theme = useTheme();
  const fromPlace = useChrome((st) => st.place);
  const { t } = useTranslation();
  const row = (testID: string, label: string, onPress: () => void, hint?: string) => (
    <Pressable
      key={testID}
      testID={testID}
      accessibilityRole="button"
      accessibilityHint={hint}
      onPress={onPress}
      style={[
        styles.row,
        { minHeight: theme.size.buttonHeight, borderBottomColor: theme.colors.separator, gap: theme.space[3] },
      ]}
    >
      <View style={styles.flex}>
        <AppText>{label}</AppText>
        {hint ? <AppText variant="callout">{hint}</AppText> : null}
      </View>
      <ChevronRight size={18} color={theme.colors.ink3} />
    </Pressable>
  );
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID="record-menu"
          style={[
            {
              backgroundColor: theme.colors.paper,
              borderTopLeftRadius: theme.radius.sheet,
              borderTopRightRadius: theme.radius.sheet,
              maxHeight: '90%',
              overflow: 'hidden',
            },
            { shadowColor: '#000000', shadowOffset: { width: 0, height: -10 }, shadowRadius: 30, shadowOpacity: 0.25, elevation: 16 },
          ]}
        >
          {/* screens-v5-extra «Меню записи»: the bottom sheet with the strip of the place it was opened from. */}
          <View style={{ height: 6, backgroundColor: theme.colors.place[fromPlace] }} />
          <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: theme.colors.line2, alignSelf: 'center', marginTop: 8 }} />
          <ScrollView contentContainerStyle={{ paddingHorizontal: theme.m.gutter, paddingTop: 12, paddingBottom: theme.space[5], gap: theme.space[2] }}>
            <AppText variant="title2" accessibilityRole="header" numberOfLines={3}>
              {title}
            </AppText>
            {mine ? (
              <AppText testID="record-menu-mine" variant="callout">
                {t('move.mine')}
              </AppText>
            ) : null}
            {(extra ?? []).slice(0, 2).map((x) => row(x.testID, x.label, x.onPress, x.hint))}
            {move ? row(move.testID, move.label, move.onPress, move.hint) : (
            <View style={[styles.pair, { gap: theme.space[2], flexDirection: theme.largeFont ? 'column' : 'row' }]}>
              <Button
                testID="record-menu-up"
                label={t('move.up')}
                accessibilityLabel={t('move.up_a11y', { what: title })}
                variant="secondary"
                icon={<ArrowUp size={22} color={theme.colors.ink} />}
                disabled={!canUp}
                onPress={onUp}
                style={styles.flex}
              />
              <Button
                testID="record-menu-down"
                label={t('move.down')}
                accessibilityLabel={t('move.down_a11y', { what: title })}
                variant="secondary"
                icon={<ArrowDown size={22} color={theme.colors.ink} />}
                disabled={!canDown}
                onPress={onDown}
                style={styles.flex}
              />
            </View>
            )}
            {onDocument ? row('record-menu-document', t('kp.make_from_file'), onDocument, t('kp.make_from_file_hint')) : null}
            {row('record-menu-move', t('move.to'), onMoveTo)}
            {row('record-menu-also', t('move.also'), onAlso)}
            {row('record-menu-remove', t('move.remove'), onRemove, t('move.remove_hint'))}
            {/* Into the trash with «Удалено · Восстановить»: not red (only irreversible actions are). */}
            {row('record-menu-delete', t('move.delete'), onDelete)}
            <Button testID="record-menu-close" label={t('common.close')} variant="secondary" onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1 },
  pair: { alignItems: 'stretch' },
  flex: { flex: 1 },
});
