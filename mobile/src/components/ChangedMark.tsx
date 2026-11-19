import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { clockOf } from '@/alarms/format';
import type { ActionOut } from '@/api/types';
import { getApi } from '@/services';
import { useToast } from '@/store/toast';
import { undoServerAction } from '@/tasks/actions';
import { rememberActions } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { hitSlopFor, pressedStyle } from './ui/motion';
import { Sheet } from './ui/Sheet';

/** design-system §10 `changedMark.ttlHours`: the mark lives a day, then goes by itself. */
export const CHANGED_MARK_TTL_MS = 24 * 3_600_000;

/** «Изменил помощник» is still shown: set by the server and younger than 24 h on this phone's clock (Ф-73). */
export function markFresh(at: string | null | undefined, now: number = Date.now()): boolean {
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && now - ms < CHANGED_MARK_TTL_MS;
}

/**
 * ChangedMark v5 (design-system §11.3, `.chg`): the terracotta dot 9 and «изменил помощник» `mark` 13/700 in
 * `assistantText`, no glow; lives 24 h.
 * A tap shows what changed and «Отменить» (`GET /v1/actions/{id}`, `POST …/undo`). Not a card on «Сегодня» (Ф-68).
 */
export function ChangedMark({ at, actionId, testID }: { at: string | null | undefined; actionId: string | null | undefined; testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!markFresh(at)) return null;
  return (
    <>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={t('changed.mark_a11y')}
        disabled={!actionId}
        onPress={() => setOpen(true)}
        hitSlop={hitSlopFor(24)}
        style={({ pressed }) => [styles.row, { gap: 5, alignSelf: 'flex-start' }, pressedStyle(pressed)]}
      >
        <View style={[styles.dot, { backgroundColor: theme.colors.place.assistant }]} />
        <AppText variant="mark" color="assistantText">
          {t('changed.mark')}
        </AppText>
      </Pressable>
      {open && actionId ? <ChangedSheet actionId={actionId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** «Что изменилось» of the action behind a mark, with «Отменить» while it can be undone. */
function ChangedSheet({ actionId, onClose }: { actionId: string; onClose: () => void }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const known = useTasks((s) => s.actions[actionId]);
  const [fetched, setFetched] = useState<ActionOut | null>(null);
  const [busy, setBusy] = useState(false);
  const action = known ?? fetched;
  const missing = !known;
  useEffect(() => {
    if (!missing) return;
    let alive = true;
    void getApi()
      .action(actionId)
      .then((a) => {
        if (!a || !alive) return;
        rememberActions([a]);
        setFetched(a);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [actionId, missing]);
  const summary = action ? (i18n.language === 'kk' && action.summary.kk) || action.summary.ru : t('changed.loading');
  const undo = async () => {
    setBusy(true);
    const r = await undoServerAction(actionId);
    setBusy(false);
    onClose();
    if (r.result === 'failed') useToast.getState().show(t('errors.generic'), 4000);
    else if (r.result === 'expired') useToast.getState().show(t('changes.expired'), 4000);
  };
  return (
    <Sheet visible testID="changed-sheet" title={t('changed.title')} onClose={onClose}>
      <AppText testID="changed-summary">{summary}</AppText>
      {action?.changes.map((c, i) => (
        <AppText key={`${c.item_id ?? 'x'}-${i}`} variant="callout" color="ink2">
          {c.text}
        </AppText>
      ))}
      {action?.undoable && !action.undone_at ? (
        <View style={{ paddingTop: theme.space[2] }}>
          <Pressable testID="changed-undo" accessibilityRole="button" accessibilityLabel={t('common.undo')} disabled={busy} onPress={() => void undo()} style={({ pressed }) => [{ minHeight: theme.size.minTouch, justifyContent: 'center', opacity: busy ? 0.4 : 1 }, pressedStyle(pressed)]}>
            <AppText style={{ color: theme.colors.assistantText, fontFamily: theme.type.headline.fontFamily, fontSize: 16 }}>{t('common.undo')}</AppText>
          </Pressable>
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 9, height: 9, borderRadius: 5 },
});

/**
 * screens-v5 «Заметка · изменил помощник»: the plate on top of an opened record while the mark lives (24 h) —
 * «● изменил помощник · 12:40 · Отменить» and one line of what changed (the action's summary). The old and new
 * words are not on the phone (the action has no diff), so the text itself is not marked.
 */
export function ChangedPlate({ at, actionId, testID = 'changed-plate' }: { at: string | null | undefined; actionId: string | null | undefined; testID?: string }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const known = useTasks((s) => (actionId ? s.actions[actionId] : undefined));
  const [fetched, setFetched] = useState<ActionOut | null>(null);
  const [busy, setBusy] = useState(false);
  const fresh = markFresh(at);
  const action = known ?? fetched;
  const missing = fresh && !!actionId && !known;
  useEffect(() => {
    if (!missing || !actionId) return;
    let alive = true;
    void getApi()
      .action(actionId)
      .then((a) => {
        if (!a || !alive) return;
        rememberActions([a]);
        setFetched(a);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [actionId, missing]);
  if (!fresh) return null;
  let time = '';
  try {
    time = new Date(at!).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  } catch {
    time = clockOf(at);
  }
  const summary = action ? (i18n.language === 'kk' && action.summary.kk) || action.summary.ru : null;
  const canUndo = !!actionId && (!action || (action.undoable && !action.undone_at));
  const undo = async () => {
    if (!actionId) return;
    setBusy(true);
    const r = await undoServerAction(actionId);
    setBusy(false);
    if (r.result === 'failed') useToast.getState().show(t('errors.generic'), 4000);
    else if (r.result === 'expired') useToast.getState().show(t('changes.expired'), 4000);
  };
  return (
    <View testID={testID} style={{ backgroundColor: theme.colors.paper2, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14, gap: 6, marginBottom: 18 }}>
      <View style={[styles.row, { gap: 6 }]}>
        <View style={[styles.dot, { backgroundColor: theme.colors.place.assistant }]} />
        <AppText variant="mark" color="assistantText" style={{ flex: 1 }}>
          {`${t('changed.mark')} · ${time}`}
        </AppText>
        {canUndo ? (
          <Pressable
            testID={`${testID}-undo`}
            accessibilityRole="button"
            accessibilityLabel={t('common.undo')}
            disabled={busy}
            onPress={() => void undo()}
            hitSlop={hitSlopFor(24)}
            style={({ pressed }) => [{ opacity: busy ? 0.4 : 1 }, pressedStyle(pressed)]}
          >
            <AppText style={{ color: theme.colors.assistantText, fontFamily: theme.type.headline.fontFamily, fontSize: 15, lineHeight: 18 }}>{t('common.undo')}</AppText>
          </Pressable>
        ) : null}
      </View>
      {summary ? <AppText variant="small">{summary}</AppText> : null}
    </View>
  );
}
