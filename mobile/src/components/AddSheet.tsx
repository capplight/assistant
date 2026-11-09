import { router } from 'expo-router';
import { AlarmClock, Camera, FileText, Image as ImageIcon, PencilLine } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

/**
 * «+» sheet: Фото / Камера / Файл / Вручную (2-design §4.3). Week 8: «Напоминание» opens the manual
 * form S13 (works offline and in «Без ИИ»). Week 13: on «Расходы» Фото / Камера / Файл bring a
 * receipt photo or a statement PDF (the receipt screen); elsewhere they are still stubs.
 * Closes with a visible «Закрыть» button, not only by swipe.
 */
export function AddSheet({ visible, onClose, expensesPageId = null }: { visible: boolean; onClose: () => void; expensesPageId?: string | null }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const receipt: Record<string, string> = { photo: 'photo', camera: 'camera', file: 'statement' };
  const works = (key: string) => key === 'reminder' || (expensesPageId !== null && key in receipt);
  const items = [
    { key: 'photo', label: t('add.photo'), Icon: ImageIcon },
    { key: 'camera', label: t('add.camera'), Icon: Camera },
    { key: 'file', label: expensesPageId ? t('exp.bring_statement') : t('add.file'), Icon: FileText },
    { key: 'manual', label: t('add.manual'), Icon: PencilLine },
    { key: 'reminder', label: t('add.reminder'), Icon: AlarmClock },
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
              testID={`add-${key}`}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint={works(key) ? undefined : t('more.later')}
              onPress={() => {
                onClose();
                if (key === 'reminder') router.push('/reminder-new');
                else if (expensesPageId && receipt[key]) router.push({ pathname: '/receipt', params: { kind: receipt[key]!, page: expensesPageId } });
              }}
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
