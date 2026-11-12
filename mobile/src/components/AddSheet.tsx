import { router } from 'expo-router';
import { AlarmClock, Camera, FileText, Image as ImageIcon, PencilLine } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';

import { ActionList, Sheet } from './ui/Sheet';

/**
 * «+» sheet: Фото / Камера / Файл / Вручную (2-design §4.3). Week 8: «Напоминание» opens the manual
 * form S13 (works offline and in «Без ИИ»). Week 13: on «Расходы» Фото / Камера / Файл bring a
 * receipt photo or a statement PDF (the receipt screen); elsewhere they are still stubs.
 * The shared `Sheet` + `ActionList`; closes with a visible «Закрыть», the scrim or back.
 */
export function AddSheet({ visible, onClose, expensesPageId = null }: { visible: boolean; onClose: () => void; expensesPageId?: string | null }) {
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
    <Sheet visible={visible} onClose={onClose} title={t('add.title')} testID="add-sheet">
      <ActionList
        actions={items.map(({ key, label, Icon }) => ({
          key,
          label,
          icon: Icon,
          testID: `add-${key}`,
          hint: works(key) ? undefined : t('more.later'),
          onPress: () => {
            onClose();
            if (key === 'reminder') router.push('/reminder-new');
            else if (expensesPageId && receipt[key]) router.push({ pathname: '/receipt', params: { kind: receipt[key]!, page: expensesPageId } });
          },
        }))}
      />
    </Sheet>
  );
}
