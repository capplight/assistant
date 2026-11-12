import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { AppText } from '@/components/AppText';
import { PageFrame } from '@/components/page/PageFrame';
import { Screen } from '@/components/Screen';
import { usePages } from '@/store/pages';

/**
 * A page (S37, v1.2): the shared `PageFrame` with the template's tool in the middle (registry in
 * `components/page/registry.tsx`, template-screens 2–3). A page is a view on the shared memory
 * (R-46): records come from local SQLite, online or not.
 * History of what the frame and the list engine keep: «Найти на странице» on the phone at once and
 * on the server when it can (week 4); «Разложи» groups and the 600 ms marker, nothing moving under
 * a finger (week 6); «⋯» Выше / Ниже / Переместить… / Показать ещё на… / Убрать, «Порядок», drag
 * (week 7); checklists of «Покупки» / «Дела» with reminders (week 9); stacks on «Заметки» (week 10);
 * «Настроить» (S38), the notebook of «Своя страница», «Простой список» for all (week 11).
 */
export default function PageScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const page = usePages((s) => s.pages.find((p) => p.id === id));
  if (!page) {
    return (
      <Screen testID="page-missing" edges={['top']}>
        <AppText variant="largeTitle">{t('page.not_found')}</AppText>
      </Screen>
    );
  }
  return <PageFrame page={page} />;
}
