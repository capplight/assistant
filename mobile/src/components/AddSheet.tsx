import { Camera, FileText, Image as ImageIcon, PencilLine } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

/**
 * «+» sheet: Фото / Камера / Файл / Вручную (2-design §4.3). UI only — all options are stubs in week 1.
 * Closes with a visible «Закрыть» button, not only by swipe.
 */
export function AddSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const items = [
    { key: 'photo', label: t('add.photo'), Icon: ImageIcon },
    { key: 'camera', label: t('add.camera'), Icon: Camera },
    { key: 'file', label: t('add.file'), Icon: FileText },
    { key: 'manual', label: t('add.manual'), Icon: PencilLine },
  ];
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID="add-sheet"
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.sheet,
              borderTopRightRadius: theme.radius.sheet,
              padding: theme.space[5],
              gap: theme.space[2],
            },
            theme.elevation?.sheet,
          ]}
        >
          <AppText variant="title2" accessibilityRole="header">
            {t('add.title')}
          </AppText>
          {items.map(({ key, label, Icon }) => (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint={t('more.later')}
              onPress={onClose}
              style={[styles.item, { minHeight: theme.size.primaryTouch, gap: theme.space[3] }]}
            >
              <Icon size={theme.size.cardIcon} color={theme.colors.ink} strokeWidth={2} />
              <AppText>{label}</AppText>
            </Pressable>
          ))}
          <Button label={t('common.close')} variant="outline" onPress={onClose} />
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: {},
  item: { flexDirection: 'row', alignItems: 'center' },
});
