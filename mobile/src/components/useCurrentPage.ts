import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { usePageLabels } from '@/pages/usePageLabels';
import { usePages, type Page } from '@/store/pages';

export type CurrentPage =
  | { kind: 'today'; id: 'today'; title: string; hintKey: string }
  | { kind: 'page'; id: string; title: string; hintKey: string; page: Page }
  | { kind: 'more'; id: 'more'; title: string; hintKey: string }
  | { kind: 'other'; id: string; title: string; hintKey: string };

/** Which page the user is on — drives the active tab and the «Про: …» chip. */
export function useCurrentPage(): CurrentPage {
  const pathname = usePathname();
  const { t } = useTranslation();
  const { title } = usePageLabels();
  const pages = usePages((s) => s.pages);
  // A record card opened from a page stays «on» that page: the same tab and «Про: …» chip.
  const { from } = useGlobalSearchParams<{ from?: string }>();

  if (pathname === '/' || pathname === '') {
    return { kind: 'today', id: 'today', title: t('tpl.today'), hintKey: 'tpl.line_hint.today' };
  }
  const m = /^\/page\/([^/]+)/.exec(pathname);
  const pageId = m?.[1] ? decodeURIComponent(m[1]) : pathname.startsWith('/record/') ? from : undefined;
  if (pageId) {
    const id = pageId;
    const page = pages.find((p) => p.id === id);
    if (page) {
      return { kind: 'page', id, title: title(page), hintKey: `tpl.line_hint.${page.templateKey}`, page };
    }
  }
  if (pathname === '/records' || pathname.startsWith('/record/')) {
    return { kind: 'other', id: 'today', title: t('more.all_records'), hintKey: 'tpl.line_hint.today' };
  }
  if (pathname.startsWith('/more')) {
    return { kind: 'more', id: 'more', title: t('more.title'), hintKey: 'tpl.line_hint.today' };
  }
  return { kind: 'other', id: pathname, title: t('tpl.today'), hintKey: 'tpl.line_hint.today' };
}
