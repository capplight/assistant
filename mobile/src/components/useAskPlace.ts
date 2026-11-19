import { usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useChrome } from '@/store/chrome';
import { useConnectivity } from '@/store/connectivity';

import { useCurrentPage } from './useCurrentPage';

/**
 * Where the assistant line shows and with which hint (Ф-81, Ф-82, design-system §11.12):
 * - `strip` on the tabs «Сегодня», «Заметки», «Расходы», «Дела», «Ещё» and inside a place (an open note / record);
 * - `full` on «Помощник» (its own field with «+»);
 * - none on settings, search, «История», «Переписки с ChatGPT», documents, onboarding and the other service screens.
 * Offline it stays: the phrase is saved as a note (Ф-69).
 */
export type AskPlace = { variant: 'strip' | 'full'; placeholder: string } | null;

export function useAskPlace(): AskPlace {
  const { t } = useTranslation();
  const pathname = usePathname();
  const current = useCurrentPage();
  const online = useConnectivity((s) => s.online);
  const hint = useChrome((s) => s.askHint);
  if (current.kind === 'assistant')
    return { variant: 'full', placeholder: online ? t('line.placeholder_assistant') : t('ask.offline') };
  // Ф-85: a future day shown on «Сегодня» says «Добавить на пятницу…».
  if (current.kind === 'today') return { variant: 'strip', placeholder: hint ?? t('ask.today') };
  if (pathname === '/more') return { variant: 'strip', placeholder: t('ask.more') };
  if (pathname.startsWith('/record/')) return { variant: 'strip', placeholder: t('ask.note_detail') };
  // plans.md: on an open plan the line changes it («поменяй план: …»; `selected_item_id` = the plan).
  if (pathname.startsWith('/plan/')) return { variant: 'strip', placeholder: t('plan.ask') };
  if (current.kind === 'page' && !pathname.startsWith('/stack/')) {
    const k = current.page.templateKey;
    if (k === 'documents') return null;
    if (k === 'expenses' && hint) return { variant: 'strip', placeholder: hint };
    if (k === 'notes' || k === 'expenses' || k === 'tasks') return { variant: 'strip', placeholder: t(`ask.${k}`) };
    return { variant: 'strip', placeholder: t('ask.today') };
  }
  return null;
}
