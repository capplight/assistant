import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import { ApiError } from '@/api/errors';
import type { HabitOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { PageIcon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { usePageLabels } from '@/pages/usePageLabels';
import { getApi, kickSync, syncBlocked } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { selectSortedPages, usePages, type Page } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { undoServerAction } from '@/tasks/actions';
import { rememberActions } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { useTheme } from '@/theme';
import { newId } from '@/utils/id';

/**
 * S30 «Что я для вас настроил» (pages.md `/habits`): the rules learned from the person's own moves
 * («Чеки кладу на страницу «Расходы»») — [Изменить] (another page, `PATCH /habits/{id}`) and
 * [Убрать] — and the records taken off a page («Не показываю «Хлеб» на странице «Заметки»») with
 * [Убрать] only. Every change has «Отменить» (the undo of its action). Learned rules also come
 * with /sync, so they show offline; exclusions only from `GET /habits`. Changing needs the internet.
 */
export default function HabitsScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { title } = usePageLabels();
  const showToast = useToast((s) => s.show);
  const synced = useTasks((s) => s.habits);
  const pages = usePages(useShallow(selectSortedPages));
  const [fetched, setFetched] = useState<HabitOut[] | null>(null);
  const [gone, setGone] = useState<string[]>([]);
  const [editing, setEditing] = useState<HabitOut | null>(null);

  const load = useCallback(() => {
    if (useOnboarding.getState().consent === null || syncBlocked()) return;
    void getApi()
      .habits()
      .then(setFetched)
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  // The server's list when there is one; else the learned rules this phone has from /sync.
  const livePage = (h: HabitOut) => !h.page || pages.some((p) => p.serverId === h.page?.id);
  const list = (fetched ?? Object.values(synced).filter((h) => h.status === 'active' && h.kind === 'placement_rule' && livePage(h))).filter(
    (h) => !gone.includes(h.id),
  );
  const offline = fetched === null;

  const strip = (text: string, actionId: string) =>
    useUndo.getState().showCustom(text, () => void undoServerAction(actionId).then(load));

  const remove = async (h: HabitOut) => {
    setGone((g) => [...g, h.id]);
    try {
      const out = await getApi().removeHabit(h.id, newId());
      kickSync();
      if (out.action) {
        rememberActions([out.action]);
        strip((i18n.language === 'kk' && out.action.summary.kk) || out.action.summary.ru, out.action.id);
      }
      load();
    } catch {
      setGone((g) => g.filter((x) => x !== h.id));
      showToast(t('habits.offline'), 4000);
    }
  };

  const move = async (h: HabitOut, page: Page) => {
    setEditing(null);
    if (!page.serverId) return;
    try {
      const out = await getApi().moveHabit(h.id, page.serverId, newId());
      kickSync();
      if (out.action) {
        rememberActions([out.action]);
        strip((i18n.language === 'kk' && out.action.summary.kk) || out.action.summary.ru, out.action.id);
      }
      load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) showToast((i18n.language === 'kk' ? e.messageKk : e.messageRu) || t('habits.exists'), 4000);
      else if (e instanceof ApiError) showToast(t('errors.generic'), 4000);
      else showToast(t('habits.offline'), 4000);
    }
  };

  const targets = editing ? pages.filter((p) => p.serverId && p.serverId !== editing.page?.id) : [];

  return (
    <Screen testID="page-habits">
      <View style={[styles.row, { marginBottom: theme.space[4] }]}>
        <Button
          testID="habits-back"
          label={t('common.back')}
          variant="text"
          minHeight={theme.size.minTouch}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
        <AppText variant="title1" accessibilityRole="header" style={styles.flex}>
          {t('habits.title')}
        </AppText>
      </View>
      <AppText variant="meta" style={{ marginBottom: theme.space[4] }}>
        {t('habits.hint')}
      </AppText>
      {offline && list.length === 0 ? <AppText testID="habits-offline">{t('habits.offline')}</AppText> : null}
      {!offline && list.length === 0 ? <AppText testID="habits-empty">{t('habits.empty')}</AppText> : null}
      {list.map((h) => {
        const text = (i18n.language === 'kk' && h.text_kk) || h.text_ru;
        return (
          <View
            key={h.id}
            testID={`habit-${h.id}`}
            style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.line, gap: theme.space[1], paddingVertical: theme.space[2] }}
          >
            <AppText>{text}</AppText>
            <View style={[styles.row, { gap: theme.space[2], flexWrap: 'wrap' }]}>
              {h.kind === 'placement_rule' ? (
                <Button
                  testID={`habit-change-${h.id}`}
                  label={t('habits.change')}
                  accessibilityLabel={t('habits.change_a11y', { what: text })}
                  variant="text"
                  minHeight={theme.size.minTouch}
                  disabled={offline}
                  onPress={() => setEditing(h)}
                />
              ) : null}
              <Button
                testID={`habit-remove-${h.id}`}
                label={t('habits.remove')}
                accessibilityLabel={t('habits.remove_a11y', { what: text })}
                variant="text"
                minHeight={theme.size.minTouch}
                onPress={() => void remove(h)}
              />
            </View>
          </View>
        );
      })}
      <Modal visible={!!editing} transparent animationType="slide" onRequestClose={() => setEditing(null)}>
        <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
          <SafeAreaView edges={['bottom']} style={{ backgroundColor: theme.colors.surface, borderTopLeftRadius: theme.radius.sheet, borderTopRightRadius: theme.radius.sheet, maxHeight: '85%' }}>
            <ScrollView contentContainerStyle={{ padding: theme.space[5], gap: theme.space[2] }}>
              <AppText variant="title2" accessibilityRole="header">
                {t('habits.change_title')}
              </AppText>
              {targets.map((p) => (
                <Pressable
                  key={p.id}
                  testID={`habit-page-${p.id}`}
                  accessibilityRole="button"
                  onPress={() => editing && void move(editing, p)}
                  style={[styles.row, { minHeight: theme.size.primaryTouch, gap: theme.space[3], borderBottomWidth: 1, borderBottomColor: theme.colors.line }]}
                >
                  <PageIcon name={p.icon} color={theme.colors.ink} size={24} />
                  <AppText style={styles.flex}>{title(p)}</AppText>
                </Pressable>
              ))}
              <Button testID="habit-change-close" label={t('common.close')} variant="text" onPress={() => setEditing(null)} />
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
