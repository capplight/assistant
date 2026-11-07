import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

/**
 * Did the server answer the last request? Only the app's own requests say so: no extra native
 * module, and what matters is reaching our server. Assumed online until a request fails.
 */
export const useConnectivity = create<{ online: boolean; setOnline: (online: boolean) => void }>()((set) => ({
  online: true,
  setOnline: (online) => set({ online }),
}));

/** «Сохранил.»; only without a connection it adds «Сделаю, когда появится связь». */
export function useSavedLine(): string {
  const { t } = useTranslation();
  const online = useConnectivity((s) => s.online);
  return online ? t('line.saved') : t('phrase.saved');
}
