import { router, useLocalSearchParams } from 'expo-router';
import { PencilLine } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { PageIcon } from '@/components/Icon';
import { PageNameSheet } from '@/components/PageNameSheet';
import { RecordRow } from '@/components/RecordRow';
import { Screen } from '@/components/Screen';
import { renamePage } from '@/pages/service';
import { usePageLabels } from '@/pages/usePageLabels';
import { usePageEntries } from '@/records/useRecords';
import { usePages } from '@/store/pages';
import { useTheme } from '@/theme';

/**
 * S37: the universal page, the same frame for every template. A view on the shared memory (R-46):
 * records come from local SQLite, online or not; the assistant line and tabs are in the layout.
 * Week 3: the list layout for all templates, «Заметки» shows it as «Последние» (stacks: F-09).
 * Not here yet: «Найти на странице» (week 4), «Порядок» and «⋯ Ещё» (week 7), «Настроить» (week 11).
 */
export default function PageScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const page = usePages((s) => s.pages.find((p) => p.id === id));
  const { title } = usePageLabels();
  const entries = usePageEntries(page);
  const [renaming, setRenaming] = useState(false);

  if (!page) {
    return (
      <Screen testID="page-missing" edges={['top']}>
        <AppText variant="title1">{t('page.not_found')}</AppText>
      </Screen>
    );
  }

  const header = (
    <View style={{ marginBottom: theme.space[4], gap: theme.space[4] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
        <PageIcon name={page.icon} color={theme.colors.ink} size={28} />
        <AppText variant="title1" accessibilityRole="header" style={{ flex: 1 }}>
          {title(page)}
        </AppText>
        {page.templateKey === 'custom' ? (
          <Pressable
            testID="page-rename"
            accessibilityRole="button"
            accessibilityLabel={t('page.rename')}
            onPress={() => setRenaming(true)}
            style={{
              width: theme.size.minTouch,
              height: theme.size.minTouch,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <PencilLine size={24} color={theme.colors.accent} />
          </Pressable>
        ) : null}
      </View>
      {entries && entries.length > 0 ? (
        <AppText variant="section" accessibilityRole="header">
          {t('page.recent')}
        </AppText>
      ) : null}
    </View>
  );

  const example =
    page.templateKey === 'notes' || page.templateKey === 'custom'
      ? t(`page.empty_example.${page.templateKey}`)
      : t(`tpl.line_hint.${page.templateKey}`);

  return (
    <Screen testID={`page-${page.templateKey}`} edges={['top']} scroll={false}>
      <FlatList
        testID="page-records"
        data={entries ?? []}
        keyExtractor={(e) => e.record.id}
        contentContainerStyle={{ paddingVertical: theme.space[4] }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListEmptyComponent={
          entries ? (
            <View
              testID="page-empty"
              style={{
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.line,
                borderWidth: 1,
                borderRadius: theme.radius.card,
                padding: theme.space[4],
                gap: theme.space[2],
              }}
            >
              <AppText>{t('page.empty')}</AppText>
              <AppText variant="meta">{example}</AppText>
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <RecordRow
            record={item.record}
            onPress={() =>
              router.navigate({ pathname: '/record/[id]', params: { id: item.record.id, from: page.id } })
            }
          />
        )}
      />
      {renaming ? (
        <PageNameSheet
          initial={page.title ?? ''}
          onClose={() => setRenaming(false)}
          onSave={(name) => {
            setRenaming(false);
            void renamePage(page.id, name);
          }}
        />
      ) : null}
    </Screen>
  );
}
