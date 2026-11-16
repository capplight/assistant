import { useTranslation } from 'react-i18next';

import { useFeatures } from '@/store/features';

import { AppText, type AppTextProps } from './AppText';

/**
 * «Подготовил помощник (ИИ) — проверьте». Ф-63: no «ИИ» label anywhere in the beta — it is behind the `ai_label`
 * feature (default off) until the lawyer's decision. The consent / disclosure texts about AI are not this label.
 */
export function AiLabel({ short = false, ...rest }: Omit<AppTextProps, 'children'> & { short?: boolean }) {
  const { t } = useTranslation();
  const on = useFeatures((f) => f.ai_label === true);
  if (!on) return null;
  return <AppText {...rest}>{t(short ? 'ai.label_short' : 'ai.label')}</AppText>;
}
