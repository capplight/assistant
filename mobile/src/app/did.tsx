import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { ActionOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { StandaloneUndoStrip } from '@/components/UndoStrip';
import { getApi, syncBlocked } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { useToast } from '@/store/toast';
import { isImportant, undoOf, undoServerAction } from '@/tasks/actions';
import { rememberActions } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { useTheme } from '@/theme';

const DAY = 86_400_000;

/**
 * S20 «Что я сделал» (2-design 5.x, actions.md): every change — the assistant's and the person's
 * own (R-33: «Вы перенесли напоминание на 8:00») — newest first, with «Отменить» while the
 * server says it can (30 days). Undone ones are crossed out with «Вернуть» (= undo of the undo).
 * Sent outside: «Отправлено, отменить нельзя». From /sync (works offline) plus `GET /actions`.
 * [Все | Только важное]: see `isImportant` (the assistant's own changes, external, deletions, merges, imports).
 */
export default function DidScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const actions = useTasks((s) => s.actions);
  const showToast = useToast((s) => s.show);
  const [now] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [onlyImportant, setOnlyImportant] = useState(false);

  useEffect(() => {
    if (useOnboarding.getState().consent === null || syncBlocked()) return;
    void getApi()
      .actions({ limit: 100 })
      .then((out) => rememberActions(out.actions))
      .catch(() => undefined);
  }, []);

  // Undo actions are shown through what they undid (crossed out + «Вернуть»), not as rows of their own.
  const list = Object.values(actions)
    .filter((a) => !a.undo_of && (!onlyImportant || isImportant(a)))
    .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''));
  const recent = list.filter((a) => !a.created_at || Date.parse(a.created_at) > now - 30 * DAY);
  const older = list.filter((a) => a.created_at && Date.parse(a.created_at) <= now - 30 * DAY);

  const time = (iso: string | null | undefined) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const sameDay = new Date(now).toDateString() === d.toDateString();
      return sameDay
        ? d.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString(i18n.language, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  };

  const run = async (id: string) => {
    setBusy(id);
    const r = await undoServerAction(id);
    setBusy(null);
    if (r.result === 'expired') showToast(t('changes.expired'), 4000);
    else if (r.result === 'failed') showToast(t('errors.generic'), 4000);
    else if (r.result === 'queued') showToast(t('did.queued'), 4000);
    else if (r.message) showToast(r.message, 4000);
  };

  const row = (a: ActionOut, canAct: boolean) => {
    const text = (i18n.language === 'kk' && a.summary.kk) || a.summary.ru;
    const back = a.undone_at ? undoOf(a.id) : undefined;
    const who = a.initiated_by === 'user' ? t('did.by_you') : t('did.by_me');
    return (
      <View
        key={a.id}
        testID={`did-${a.id}`}
        style={[styles.row, { borderBottomWidth: 1, borderBottomColor: theme.colors.line, gap: theme.space[2], paddingVertical: theme.space[2] }]}
      >
        <View style={styles.flex}>
          <AppText
            color={a.undone_at ? 'ink2' : 'ink'}
            style={a.undone_at ? { textDecorationLine: 'line-through' } : undefined}
          >
            {text}
          </AppText>
          <AppText variant="meta">{`${who} · ${time(a.created_at)}`}</AppText>
          {a.scope === 'external' ? <AppText variant="meta">{t('did.external')}</AppText> : null}
        </View>
        {canAct && a.undoable && !a.undone_at ? (
          <Button
            testID={`did-undo-${a.id}`}
            label={t('common.undo')}
            accessibilityLabel={t('did.undo_a11y', { what: text })}
            variant="text"
            minHeight={theme.size.minTouch}
            disabled={busy === a.id}
            onPress={() => void run(a.id)}
          />
        ) : null}
        {canAct && back ? (
          <Button
            testID={`did-redo-${a.id}`}
            label={t('changes.revert')}
            accessibilityLabel={t('did.redo_a11y', { what: text })}
            variant="text"
            minHeight={theme.size.minTouch}
            disabled={busy === back.id}
            onPress={() => void run(back.id)}
          />
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.flex}>
      <Screen testID="page-did" edges={['top']}>
        <View style={[styles.row, { marginBottom: theme.space[4] }]}>
          <Button
            testID="did-back"
            label={t('common.back')}
            variant="text"
            minHeight={theme.size.minTouch}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          />
          <AppText variant="title1" accessibilityRole="header" style={styles.flex}>
            {t('more.did')}
          </AppText>
        </View>
        <View style={[styles.row, { gap: theme.space[2], marginBottom: theme.space[4], flexWrap: 'wrap' }]}>
          {[false, true].map((on) => (
            <Button
              key={String(on)}
              testID={on ? 'did-important' : 'did-all'}
              label={on ? t('did.only_important') : t('did.all')}
              variant={onlyImportant === on ? 'primary' : 'outline'}
              minHeight={theme.size.minTouch}
              accessibilityState={{ selected: onlyImportant === on }}
              onPress={() => setOnlyImportant(on)}
            />
          ))}
        </View>
        {recent.length === 0 && older.length === 0 ? <AppText testID="did-empty">{t('did.empty')}</AppText> : null}
        {recent.map((a) => row(a, true))}
        {older.length > 0 ? (
          <AppText variant="section" accessibilityRole="header" style={{ marginTop: theme.space[6] }}>
            {t('did.older')}
          </AppText>
        ) : null}
        {older.map((a) => row(a, false))}
        <Pressable
          testID="did-habits"
          accessibilityRole="button"
          onPress={() => router.push('/habits')}
          style={[styles.row, { minHeight: theme.size.primaryTouch, marginTop: theme.space[6], gap: theme.space[2] }]}
        >
          <AppText color="accent" style={styles.flex}>
            {t('habits.title')}
          </AppText>
          <ChevronRight size={22} color={theme.colors.accent} />
        </Pressable>
      </Screen>
      <StandaloneUndoStrip />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
