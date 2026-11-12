import { router } from 'expo-router';
import { ArrowDown, ArrowUp, ChevronLeft, Ellipsis } from 'lucide-react-native';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { PageIcon } from '@/components/Icon';
import { PageNameSheet } from '@/components/PageNameSheet';
import { Screen } from '@/components/Screen';
import { useDrag } from '@/components/useDrag';
import { movePage, removePage, stepPage } from '@/pages/manual';
import { addCustomPage, renamePage } from '@/pages/service';
import { MAX_PAGES, MAX_TAB_PAGES, MAX_TAB_PAGES_LARGE_FONT } from '@/pages/templates';
import { usePageLabels } from '@/pages/usePageLabels';
import { selectSortedPages, usePages, type Page } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

/**
 * S34 «Мои страницы» (2-design 5.2, F-38, F-41): the order of the pages = the order of the tabs.
 * «Сегодня» first, always, without buttons. Each page: ↑ ↓ (48 pt), «⋯» (Открыть, Переименовать,
 * Убрать страницу), long press → drag (the double of ↑ ↓). The tab line is drawn where the tabs
 * end (2 at font ≥150%). Every change at once with «Отменить», offline and in «Без ИИ» too.
 * «+ Добавить страницу» just makes a «Своя страница» (founder, week 16); the ready pages (S35
 * «Добавить (N)») open only from «Готовые страницы» below it, when the person asks for them.
 */
export default function MyPagesScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { title } = usePageLabels();
  const pages = usePages(useShallow(selectSortedPages));
  const showToast = useToast((s) => s.show);
  const [menuFor, setMenuFor] = useState<Page | null>(null);
  const [naming, setNaming] = useState<{ page: Page | null } | null>(null);
  const drag = useDrag();
  const inTabs = theme.largeFont ? MAX_TAB_PAGES_LARGE_FONT : MAX_TAB_PAGES;
  const total = pages.length + 1; // «Сегодня» counts (pages.md: 20 including it)

  const arrow = (p: Page, i: number, step: -1 | 1) => {
    const can = step < 0 ? i > 0 : i < pages.length - 1;
    const Icon = step < 0 ? ArrowUp : ArrowDown;
    const name = title(p);
    return (
      <Pressable
        testID={`my-pages-${step < 0 ? 'up' : 'down'}-${p.id}`}
        accessibilityRole="button"
        accessibilityLabel={t(step < 0 ? 'move.up_a11y' : 'move.down_a11y', { what: name })}
        accessibilityState={{ disabled: !can }}
        disabled={!can}
        onPress={() => void stepPage(p.id, step)}
        style={[styles.square, { width: theme.size.minTouch, height: theme.size.minTouch, opacity: can ? 1 : 0.35 }]}
      >
        <Icon size={24} color={theme.colors.brand} />
      </Pressable>
    );
  };

  const card = {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.separator,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.space[3],
    minHeight: theme.size.buttonHeight,
    marginBottom: theme.space[2],
    gap: theme.space[2],
  };

  return (
    <Screen testID="my-pages-screen" edges={['top']} scroll={false}>
      <View style={{ flex: 1 }} {...drag.handlers}>
        <ScrollView scrollEnabled={!drag.active} contentContainerStyle={{ paddingVertical: theme.space[4] }}>
          <Button
            testID="my-pages-back"
            label={t('common.back')}
            variant="text"
            minHeight={theme.size.minTouch}
            icon={<ChevronLeft size={22} color={theme.colors.brand} />}
            onPress={() => router.navigate('/more')}
            style={styles.back}
          />
          <AppText variant="largeTitle" accessibilityRole="header">
            {t('pages.my')}
          </AppText>
          <AppText variant="callout" style={{ marginBottom: theme.space[4] }}>
            {t('pages.in_tabs', { n: inTabs })}
          </AppText>
          <View testID="my-pages-today" style={[styles.row, styles.border, card]}>
            <PageIcon name="today" size={24} color={theme.colors.ink} />
            <AppText style={styles.flex}>{t('tpl.today')}</AppText>
            <AppText variant="callout">{t('pages.today_fixed')}</AppText>
          </View>
          {pages.map((p, i) => {
            const shift = drag.shift(i);
            return (
              <Fragment key={p.id}>
                {i === inTabs ? (
                  <AppText
                    testID="my-pages-tabs-end"
                    variant="callout"
                    style={{ marginVertical: theme.space[2], textAlign: 'center' }}
                  >
                    {t('pages.tabs_end')}
                  </AppText>
                ) : null}
                <View
                  testID={`my-pages-row-${p.id}`}
                  onLayout={(e) => drag.measure(i, e.nativeEvent.layout.height + theme.space[2])}
                  style={[
                    styles.row,
                    styles.border,
                    card,
                    shift ? { transform: [{ translateY: shift }], zIndex: drag.isDragged(i) ? 10 : 0 } : null,
                    drag.isDragged(i) ? [{ borderColor: theme.colors.brand }, theme.elevation.floating] : null,
                  ]}
                >
                  <Pressable
                    testID={`my-pages-open-${p.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={title(p)}
                    accessibilityHint={t('move.drag_hint')}
                    accessibilityActions={[
                      ...(i > 0 ? [{ name: 'up', label: t('move.up') }] : []),
                      ...(i < pages.length - 1 ? [{ name: 'down', label: t('move.down') }] : []),
                    ]}
                    onAccessibilityAction={(e) => void stepPage(p.id, e.nativeEvent.actionName === 'up' ? -1 : 1)}
                    onPress={() => router.navigate({ pathname: '/page/[id]', params: { id: p.id } })}
                    onLongPress={() => drag.start(i, (to) => void movePage(p.id, to))}
                    delayLongPress={400}
                    style={[styles.row, styles.flex, { minHeight: theme.size.buttonHeight, gap: theme.space[3] }]}
                  >
                    <PageIcon name={p.icon} size={24} color={theme.colors.ink} />
                    <AppText style={styles.flex}>{title(p)}</AppText>
                  </Pressable>
                  {arrow(p, i, -1)}
                  {arrow(p, i, 1)}
                  <Pressable
                    testID={`my-pages-menu-${p.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('pages.more_a11y', { page: title(p) })}
                    onPress={() => setMenuFor(p)}
                    style={[styles.square, { width: theme.size.minTouch, height: theme.size.minTouch }]}
                  >
                    <Ellipsis size={24} color={theme.colors.brand} />
                  </Pressable>
                </View>
              </Fragment>
            );
          })}
          <Button
            testID="my-pages-add"
            label={`+ ${t('pages.add')}`}
            variant="secondary"
            disabled={total >= MAX_PAGES}
            onPress={() => setNaming({ page: null })}
            style={{ marginTop: theme.space[3] }}
          />
          <Button
            testID="my-pages-templates"
            label={t('pages.ready')}
            variant="text"
            minHeight={theme.size.minTouch}
            disabled={total >= MAX_PAGES}
            onPress={() => router.push('/pages-gallery')}
          />
          <AppText testID="my-pages-count" variant="callout" style={{ marginTop: theme.space[2] }}>
            {t('pages.count', { n: total })}
          </AppText>
          {total >= MAX_PAGES ? <AppText variant="callout">{t('gallery.limit')}</AppText> : null}
        </ScrollView>
      </View>
      {menuFor ? (
        <PageMenu
          name={title(menuFor)}
          onOpen={() => {
            const id = menuFor.id;
            setMenuFor(null);
            router.navigate({ pathname: '/page/[id]', params: { id } });
          }}
          onRename={() => {
            setNaming({ page: menuFor });
            setMenuFor(null);
          }}
          onRemove={() => {
            const id = menuFor.id;
            setMenuFor(null);
            void removePage(id);
          }}
          onClose={() => setMenuFor(null)}
        />
      ) : null}
      {naming ? (
        <PageNameSheet
          initial={naming.page?.title ?? ''}
          onClose={() => setNaming(null)}
          onSave={(name) => {
            const page = naming.page;
            setNaming(null);
            if (page) {
              void renamePage(page.id, name);
              return;
            }
            void addCustomPage(name).then((created) => {
              if (!created) showToast(t('gallery.limit'), 4000);
            });
          }}
        />
      ) : null}
    </Screen>
  );
}

/** «⋯» of a page in S34: Открыть, Переименовать, Убрать страницу («Записи останутся»), Закрыть. */
function PageMenu({
  name,
  onOpen,
  onRename,
  onRemove,
  onClose,
}: {
  name: string;
  onOpen: () => void;
  onRename: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID="my-pages-sheet"
          style={[
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.sheet,
              borderTopRightRadius: theme.radius.sheet,
              padding: theme.space[5],
              gap: theme.space[2],
            },
            theme.elevation.floating,
          ]}
        >
          <AppText variant="title2" accessibilityRole="header">
            {name}
          </AppText>
          <Button testID="my-pages-sheet-open" label={t('pages.open')} variant="secondary" onPress={onOpen} />
          <Button testID="my-pages-sheet-rename" label={t('pages.rename')} variant="secondary" onPress={onRename} />
          <Button
            testID="my-pages-sheet-remove"
            label={t('pages.remove')}
            accessibilityHint={t('pages.remove_hint')}
            variant="text"
            labelColor="danger"
            onPress={onRemove}
          />
          <AppText variant="callout">{t('pages.remove_hint')}</AppText>
          <Button testID="my-pages-sheet-close" label={t('common.close')} variant="text" onPress={onClose} />
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  border: { borderWidth: 1 },
  flex: { flex: 1 },
  square: { alignItems: 'center', justifyContent: 'center' },
  back: { alignSelf: 'flex-start', paddingHorizontal: 0 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
