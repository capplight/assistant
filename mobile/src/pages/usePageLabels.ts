import { useTranslation } from 'react-i18next';

import type { Page } from '@/store/pages';

/** Full title (page header, chip) and short tab label (≤10 chars; custom = first word). */
export function usePageLabels() {
  const { t, i18n } = useTranslation();
  const own = (p: Page) => (i18n.language === 'kk' ? (p.titleKk ?? p.title) : p.title);
  const title = (p: Page) =>
    own(p) ?? (p.templateKey === 'custom' ? t('tpl.custom_default') : t(`tpl.${p.templateKey}`));
  const tabLabel = (p: Page) => {
    if (p.templateKey === 'custom') return title(p).split(/\s+/)[0] ?? title(p);
    return own(p) ?? t(`tpl.short.${p.templateKey}`);
  };
  return { title, tabLabel };
}
