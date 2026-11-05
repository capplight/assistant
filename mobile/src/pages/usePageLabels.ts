import { useTranslation } from 'react-i18next';

import type { Page } from '@/store/pages';

/** Full title (page header, chip) and short tab label (≤10 chars; custom = first word). */
export function usePageLabels() {
  const { t } = useTranslation();
  const title = (p: Page) =>
    p.title ?? (p.templateKey === 'custom' ? t('tpl.custom_default') : t(`tpl.${p.templateKey}`));
  const tabLabel = (p: Page) => {
    if (p.templateKey === 'custom') return title(p).split(/\s+/)[0] ?? title(p);
    return p.title ?? t(`tpl.short.${p.templateKey}`);
  };
  return { title, tabLabel };
}
