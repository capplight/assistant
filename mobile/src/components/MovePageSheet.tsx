import { Check } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import type { LocalRecord } from '@/db';
import { pagesShowing } from '@/pages/manual';
import { addCustomPage } from '@/pages/service';
import { usePageLabels } from '@/pages/usePageLabels';
import { selectSortedPages, usePages, type Page } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';
import { PageIcon } from './Icon';
import { PageNameSheet } from './PageNameSheet';

export type MoveMode = 'move' | 'also_show';

/**
 * S39 «Переместить на страницу» (2-design 5.2, US-27): two modes. «Переместить» — one page, the
 * record leaves this one; «Показать ещё на» — several (☑), it stays here too. The page it is on is
 * marked «сейчас здесь», pages that show it already «уже там ✓». «+ Новая страница» makes a
 * «Своя страница» and picks it. Rows 56 pt; «Закрыть» closes, not only a swipe.
 */
export function MovePageSheet({
  record,
  recordTitle,
  current,
  initialMode,
  onDone,
  onClose,
}: {
  record: LocalRecord;
  recordTitle: string;
  current: Page;
  initialMode: MoveMode;
  onDone: (mode: MoveMode, targets: Page[]) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { title } = usePageLabels();
  const pages = usePages(useShallow(selectSortedPages));
  const showToast = useToast((s) => s.show);
  const [mode, setMode] = useState<MoveMode>(initialMode);
  const [picked, setPicked] = useState<string[]>([]);
  const [shownOn, setShownOn] = useState<Set<string> | null>(null);
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    let alive = true;
    void pagesShowing(record, usePages.getState().pages).then((s) => {
      if (alive) setShownOn(s);
    });
    return () => {
      alive = false;
    };
  }, [record, pages.length]);

  const switchMode = (m: MoveMode) => {
    setMode(m);
    setPicked([]);
  };

  const toggle = (id: string) => {
    if (mode === 'move') setPicked([id]);
    else setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  const targets = picked.map((id) => pages.find((p) => p.id === id)).filter((p): p is Page => !!p);
  const first = targets[0];
  const go =
    mode === 'move'
      ? first
        ? t('move.move_to', { page: title(first) })
        : t('move.pick')
      : targets.length > 0
        ? t('move.also_button', { n: targets.length })
        : t('move.pick');

  const segment = (m: MoveMode, label: string) => {
    const on = mode === m;
    return (
      <Pressable
        testID={`move-mode-${m}`}
        accessibilityRole="radio"
        accessibilityState={{ selected: on, checked: on }}
        onPress={() => switchMode(m)}
        style={[
          styles.segment,
          {
            minHeight: theme.size.minTouch,
            borderRadius: theme.radius.button,
            backgroundColor: on ? theme.colors.accent : 'transparent',
            paddingHorizontal: theme.space[2],
          },
        ]}
      >
        <AppText variant="button" color={on ? 'onAccent' : 'accent'} style={styles.center}>
          {label}
        </AppText>
      </Pressable>
    );
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID="move-sheet"
          style={[
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.sheet,
              borderTopRightRadius: theme.radius.sheet,
              maxHeight: '90%',
            },
            theme.elevation?.sheet,
          ]}
        >
          <ScrollView contentContainerStyle={{ padding: theme.space[5], gap: theme.space[3] }}>
            <AppText variant="title2" accessibilityRole="header">
              {mode === 'move' ? t('move.sheet_move') : t('move.sheet_also')}
            </AppText>
            <AppText variant="meta" numberOfLines={2}>
              «{recordTitle}»
            </AppText>
            <View
              accessibilityRole="radiogroup"
              style={[
                styles.segments,
                {
                  borderColor: theme.colors.accent,
                  borderRadius: theme.radius.button,
                  gap: theme.space[1],
                  padding: 2,
                  flexDirection: theme.largeFont ? 'column' : 'row',
                },
              ]}
            >
              {segment('move', t('move.mode_move'))}
              {segment('also_show', t('move.mode_also'))}
            </View>
            {pages.map((p) => {
              const here = p.id === current.id;
              const there = !here && !!shownOn?.has(p.id);
              const disabled = here || (mode === 'also_show' && there);
              const on = picked.includes(p.id) || (mode === 'also_show' && there);
              const note = here ? t('move.here') : there ? t('move.there') : null;
              return (
                <Pressable
                  key={p.id}
                  testID={`move-target-${p.id}`}
                  accessibilityRole={mode === 'move' ? 'radio' : 'checkbox'}
                  accessibilityState={{ checked: on, disabled }}
                  accessibilityLabel={[title(p), note].filter(Boolean).join(', ')}
                  disabled={disabled}
                  onPress={() => toggle(p.id)}
                  style={[
                    styles.row,
                    {
                      minHeight: theme.size.primaryTouch,
                      borderBottomColor: theme.colors.line,
                      gap: theme.space[3],
                      opacity: disabled ? 0.55 : 1,
                    },
                  ]}
                >
                  <View
                    style={[
                      mode === 'move' ? styles.radio : styles.box,
                      {
                        borderColor: on ? theme.colors.accent : theme.colors.lineStrong,
                        backgroundColor: on ? theme.colors.accent : theme.colors.surface,
                      },
                    ]}
                  >
                    {on ? <Check size={18} color={theme.colors.onAccent} strokeWidth={3} /> : null}
                  </View>
                  <PageIcon name={p.icon} size={24} color={theme.colors.ink} />
                  <View style={styles.flex}>
                    <AppText>{title(p)}</AppText>
                    {note ? <AppText variant="meta">{note}</AppText> : null}
                  </View>
                </Pressable>
              );
            })}
            <Button testID="move-new-page" label={t('move.new_page')} variant="text" onPress={() => setNaming(true)} />
            <Button testID="move-go" label={go} disabled={targets.length === 0} onPress={() => onDone(mode, targets)} />
            <Button testID="move-close" label={t('common.close')} variant="outline" onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </View>
      {naming ? (
        <PageNameSheet
          onClose={() => setNaming(false)}
          onSave={(name) => {
            setNaming(false);
            void addCustomPage(name).then((page) => {
              if (page) toggle(page.id);
              else showToast(t('gallery.limit'), 4000);
            });
          }}
        />
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  segments: { borderWidth: 2 },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1 },
  radio: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  box: { width: 28, height: 28, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
