import { router } from 'expo-router';
import { AlarmClock, Camera, FileText, Image as ImageIcon, QrCode } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';

import { useFeatures } from '@/store/features';

import { ActionList, Sheet, type SheetAction } from './ui/Sheet';

/**
 * «+» sheet (Ф-50, ux-review-2 §3): only what works — no «Появится позже». Everywhere: «Напоминание» (the manual form
 * S13, offline and in «Без ИИ» too). On «Расходы»: «Фото чека» and «Камера» (the receipt screen); «Выписка PDF» only
 * while `statements_pdf` is on (Ф-37: the flag is off for the beta, the screen must not be reachable).
 */
export function AddSheet({ visible, onClose, expensesPageId = null }: { visible: boolean; onClose: () => void; expensesPageId?: string | null }) {
  const { t } = useTranslation();
  const statements = useFeatures((f) => f.statements_pdf);
  const qr = useFeatures((f) => f.receipt_qr);
  const receipt = (kind: 'photo' | 'camera' | 'statement' | 'qr') => () => {
    onClose();
    if (expensesPageId) router.push({ pathname: '/receipt', params: { kind, page: expensesPageId } });
  };
  const actions: SheetAction[] = [];
  if (expensesPageId) {
    actions.push({ key: 'photo', testID: 'add-photo', label: t('add.receipt_photo'), icon: ImageIcon, onPress: receipt('photo') });
    actions.push({ key: 'camera', testID: 'add-camera', label: t('add.camera'), icon: Camera, onPress: receipt('camera') });
    if (qr) actions.push({ key: 'qr', testID: 'add-qr', label: t('exp.bring_qr'), icon: QrCode, onPress: receipt('qr') });
    if (statements) actions.push({ key: 'file', testID: 'add-file', label: t('exp.bring_statement'), icon: FileText, onPress: receipt('statement') });
  }
  actions.push({
    key: 'reminder',
    testID: 'add-reminder',
    label: t('add.reminder'),
    icon: AlarmClock,
    onPress: () => {
      onClose();
      router.push('/reminder-new');
    },
  });
  return (
    <Sheet visible={visible} onClose={onClose} title={t('add.title')} testID="add-sheet" place="assistant">
      <ActionList actions={actions} />
    </Sheet>
  );
}
