import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { PageIcon } from '@/components/Icon';
import { PageNameSheet } from '@/components/PageNameSheet';
import { RecordRow } from '@/components/RecordRow';
import { Screen } from '@/components/Screen';
import { beforeAfterText, stackCount, stackIcon, stackTitle } from '@/components/StackCards';
import { removeFromStack, renameStack, takeApartStack } from '@/dedup/service';
import { stackToPage } from '@/pages/viewService';
import { useDedup } from '@/dedup/store';
import { recordTitle } from '@/records/format';
import { usePageEntries } from '@/records/useRecords';
import { usePages } from '@/store/pages';
import { useTheme } from '@/theme';

/**
 * S11 «Стопка», inside its page (2-design 3.6, 5.3): «‹ Назад» to the page; name, icon, count and
 * «было → стало»; [Переименовать], [Разобрать стопку] (the records stay); the records with their
 * sources and «Убрать из стопки» (the assistant does not put it back, R-54). Every change has
 * «Отменить» (the undo of the server's action). Changes need the internet; reading works offline.
 * Week 11: «Сделать страницей» (founder addition) — a «Своя страница» with these records, with
 * «Отменить»; the records stay here too (a page is a view). Not here yet: the line chip
 * «Про: <стопка>», the summary (P1).
 */
export default function StackScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>();
  const stack = useDedup((s) => (id ? s.collections[id] : undefined));
  const gone = useDedup((s) => (id ? s.goneCollections.includes(id) : false));
  const page = usePages((s) => s.pages.find((p) => (from ? p.id === from : !!stack?.page_id && p.serverId === stack.page_id)));
  const entries = usePageEntries(page);
  const [renaming, setRenaming] = useState(false);
  const [removed, setRemoved] = useState<string[]>([]);

  const back = () => {
    if (page) router.navigate({ pathname: '/page/[id]', params: { id: page.id } });
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (!stack || gone) {
    return (
      <Screen testID="stack-missing" edges={['top']}>
        <Button testID="stack-back" label={`‹ ${t('common.back')}`} variant="text" minHeight={theme.size.minTouch} onPress={back} style={styles.start} />
        <AppText>{t('stack.not_found')}</AppText>
      </Screen>
    );
  }

  const name = stackTitle(stack, i18n.language);
  const rows = (entries ?? []).filter((e) => e.link?.groupKey === stack.title && !removed.includes(e.record.id));
  const count = rows.length > 0 ? rows.length : stackCount(stack, entries);
  const ba = beforeAfterText(stack, t);

  return (
    <Screen testID="stack-screen" edges={['top']} scroll={false}>
      <FlatList
        testID="stack-records"
        data={rows}
        keyExtractor={(e) => e.record.id}
        contentContainerStyle={{ paddingVertical: theme.space[4] }}
        ListHeaderComponent={
          <View style={{ gap: theme.space[3], marginBottom: theme.space[4] }}>
            <Button testID="stack-back" label={`‹ ${t('common.back')}`} variant="text" minHeight={theme.size.minTouch} onPress={back} style={styles.start} />
            <View style={[styles.row, { gap: theme.space[3] }]}>
              <PageIcon name={stackIcon(stack)} color={theme.colors.ink} size={28} />
              <AppText variant="title1" accessibilityRole="header" style={styles.flex}>
                {name}
              </AppText>
            </View>
            <AppText testID="stack-count">{t('stack.records', { count })}</AppText>
            {ba ? <AppText variant="meta">{ba}</AppText> : null}
            <View style={[styles.row, { gap: theme.space[2], flexWrap: 'wrap' }]}>
              <Button testID="stack-rename" label={t('stack.rename')} variant="outline" minHeight={theme.size.minTouch} onPress={() => setRenaming(true)} />
              <Button
                testID="stack-to-page"
                label={t('stack.to_page')}
                accessibilityHint={t('stack.to_page_hint')}
                variant="outline"
                minHeight={theme.size.minTouch}
                onPress={() =>
                  void stackToPage(stack).then((pageId) => {
                    if (pageId) router.navigate({ pathname: '/page/[id]', params: { id: pageId } });
                  })
                }
              />
              <Button
                testID="stack-take-apart"
                label={t('stack.take_apart')}
                accessibilityHint={t('stack.take_apart_hint')}
                variant="text"
                minHeight={theme.size.minTouch}
                onPress={() =>
                  void takeApartStack(stack).then((ok) => {
                    if (ok) back();
                  })
                }
              />
            </View>
          </View>
        }
        ListEmptyComponent={<AppText testID="stack-empty">{t('stack.empty')}</AppText>}
        renderItem={({ item }) => {
          const rec = item.record;
          const title = recordTitle(rec, t);
          return (
            <View style={{ gap: theme.space[1] }}>
              <RecordRow
                record={rec}
                onPress={() => router.navigate({ pathname: '/record/[id]', params: { id: rec.id, from: page?.id ?? '' } })}
              />
              {rec.serverId ? (
                <Button
                  testID={`stack-remove-${rec.id}`}
                  label={t('stack.remove_item')}
                  accessibilityLabel={t('stack.remove_item_a11y', { title })}
                  variant="text"
                  minHeight={theme.size.minTouch}
                  style={styles.end}
                  onPress={() => {
                    const serverId = rec.serverId!;
                    setRemoved((r) => [...r, rec.id]);
                    void removeFromStack(stack, serverId).then((ok) => {
                      if (!ok) setRemoved((r) => r.filter((x) => x !== rec.id));
                    });
                  }}
                />
              ) : null}
            </View>
          );
        }}
      />
      {renaming ? (
        <PageNameSheet
          title={t('stack.rename_title')}
          initial={stack.title}
          onClose={() => setRenaming(false)}
          onSave={(value) => {
            setRenaming(false);
            void renameStack(stack, value);
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  start: { alignSelf: 'flex-start' },
  end: { alignSelf: 'flex-end' },
});
