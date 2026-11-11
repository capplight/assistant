import { router } from 'expo-router';
import { useShallow } from 'zustand/react/shallow';

import { Gallery } from '@/components/Gallery';
import { addTemplatePages } from '@/onboarding/service';
import { MAX_PAGES } from '@/pages/templates';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';
import i18n from '@/i18n';

/**
 * S35 later («Мои страницы» → «Готовые страницы», 2-design 6.13): nothing marked, the pages the
 * person has are «Уже есть ✓», «Добавить (N)». Only when the person asks for the ready pages:
 * «+ Добавить страницу» itself still makes one «Своя страница» (founder, week 16).
 */
export default function PagesGalleryScreen() {
  const existing = usePages(useShallow((s) => s.pages.map((p) => p.templateKey)));
  const count = usePages((s) => s.pages.length);
  return (
    <Gallery
      mode="add"
      initial={[]}
      existing={existing}
      onDone={(keys) => {
        if (count + keys.length + 1 > MAX_PAGES) {
          useToast.getState().show(i18n.t('gallery.limit'), 4000);
          return;
        }
        void addTemplatePages(keys).then((added) => {
          if (added[0]) router.replace({ pathname: '/page/[id]', params: { id: added[0].id } });
          else router.back();
        });
      }}
    />
  );
}
