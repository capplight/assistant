import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { usePageLabels } from '@/pages/usePageLabels';
import { usePages, type Page } from '@/store/pages';

export type CurrentPage =
  | { kind: 'today'; id: 'today'; title: string; hintKey: string }
  | { kind: 'page'; id: string; title: string; hintKey: string; page: Page }
  | { kind: 'more'; id: 'more'; title: string; hintKey: string }
  | { kind: 'other'; id: string; title: string; hintKey: string };

/** Which page the user is on — drives the active tab and the hidden page context of the line («это / здесь», Ф-47). */
export function useCurrentPage(): CurrentPage {
  const pathname = usePathname();
  const { t } = useTranslation();
  const { title } = usePageLabels();
  const pages = usePages((s) => s.pages);
  // A record card opened from a page stays «on» that page: the same tab and «Про: …» chip.
  const { from } = useGlobalSearchParams<{ from?: string }>();

  if (pathname === '/' || pathname === '') {
    return { kind: 'today', id: 'today', title: t('tpl.today'), hintKey: 'tpl.line_hint_now.today' };
  }
  const m = /^\/page\/([^/]+)/.exec(pathname);
  // S11 (a stack) lives inside its page too.
  const inside = pathname.startsWith('/record/') || pathname.startsWith('/stack/');
  const pageId = m?.[1] ? decodeURIComponent(m[1]) : inside ? from : undefined;
  if (pageId) {
    const id = pageId;
    const page = pages.find((p) => p.id === id);
    if (page) {
      return { kind: 'page', id, title: title(page), hintKey: `tpl.line_hint_now.${page.templateKey}`, page };
    }
  }
  if (pathname === '/search') {
    return { kind: 'other', id: 'today', title: t('search.title'), hintKey: 'tpl.line_hint_now.today' };
  }
  if (pathname === '/trash') {
    return { kind: 'other', id: 'today', title: t('trash.title'), hintKey: 'tpl.line_hint_now.today' };
  }
  if (pathname === '/records' || pathname.startsWith('/record/')) {
    return { kind: 'other', id: 'today', title: t('more.all_records'), hintKey: 'tpl.line_hint_now.today' };
  }
  if (pathname === '/chat') {
    return { kind: 'other', id: 'today', title: t('chat.title'), hintKey: 'tpl.line_hint_now.today' };
  }
  if (pathname.startsWith('/more') || pathname === '/my-pages' || pathname === '/duplicates' || pathname === '/import') {
    return { kind: 'more', id: 'more', title: t('more.title'), hintKey: 'tpl.line_hint_now.today' };
  }
  return { kind: 'other', id: pathname, title: t('tpl.today'), hintKey: 'tpl.line_hint_now.today' };
}
