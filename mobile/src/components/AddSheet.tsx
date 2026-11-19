import { router } from 'expo-router';
import { AlarmClock, Camera, FileText, Image as ImageIcon, PencilLine, ReceiptText } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';

import { showSavedToast } from '@/chat/service';
import { getMedia, type PickedMedia } from '@/expenses/media';
import { getCapture } from '@/services';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';

import { ActionList, Sheet, type SheetAction } from './ui/Sheet';

/**
 * «Добавить» (add-entry-model.md, screens-v5-extra «Добавить · «+» в «Помощнике»»): the only «Добавить» sheet in the
 * app, opened by the «+» of the full assistant line. Камера · Фото из галереи · Файл · Фото чека (straight to
 * «Расходы») · Напоминание · Написать вручную. Everything works offline and in «Без ИИ»: a photo or a file is saved
 * as a record (the server places it, Ф-47), a note is typed on its own screen.
 */
export function AddSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const save = async (m: PickedMedia | null, source: 'camera' | 'files', what: string) => {
    if (!m) return;
    const rec = await (await getCapture()).saveFile({ uri: m.uri, mime: m.mime, name: m.name, source });
    showSavedToast(rec.id, what);
  };
  const run = (job: () => Promise<void>) => () => {
    onClose();
    void job().catch((e: unknown) => {
      console.warn('add pick failed', e);
      useToast.getState().show(t('exp.pick_failed'), 4000);
    });
  };
  const media = getMedia;
  const actions: SheetAction[] = [
    {
      key: 'camera',
      testID: 'add-camera',
      label: t('add.camera'),
      icon: Camera,
      onPress: run(async () => {
        let perm = await media().cameraPermission();
        if (perm !== 'granted') perm = await media().requestCamera();
        if (perm !== 'granted') {
          useToast.getState().show(t('exp.camera_blocked'), 4000);
          return;
        }
        await save(await media().takePhoto(), 'camera', t('add.photo'));
      }),
    },
    {
      key: 'photo',
      testID: 'add-photo',
      label: t('add.gallery'),
      icon: ImageIcon,
      onPress: run(async () => save(await media().pickPhoto(), 'files', t('add.photo'))),
    },
    {
      key: 'file',
      testID: 'add-file',
      label: t('add.file'),
      icon: FileText,
      onPress: run(async () => save(await media().pickPdf(), 'files', t('add.file'))),
    },
    {
      key: 'receipt',
      testID: 'add-receipt',
      label: t('add.receipt_photo'),
      icon: ReceiptText,
      onPress: () => {
        // QA v5-device-3 J12: the next screen opens first; the sheet closes under it (no in-between state).
        const exp = usePages.getState().pages.find((p) => p.templateKey === 'expenses');
        router.push({ pathname: '/receipt', params: { kind: 'camera', ...(exp ? { page: exp.id } : {}) } });
        onClose();
      },
    },
    {
      key: 'reminder',
      testID: 'add-reminder',
      label: t('add.reminder'),
      icon: AlarmClock,
      onPress: () => {
        router.push('/reminder-new');
        onClose();
      },
    },
    {
      key: 'manual',
      testID: 'add-manual',
      label: t('add.write'),
      icon: PencilLine,
      onPress: () => {
        router.push('/note-new');
        onClose();
      },
    },
  ];
  return (
    <Sheet visible={visible} onClose={onClose} title={t('add.title')} testID="add-sheet">
      <ActionList actions={actions} />
    </Sheet>
  );
}
