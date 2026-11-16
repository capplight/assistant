import { MessageCircleMore } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { ActionOut } from '@/api/types';
import { getApi } from '@/services';
import { useToast } from '@/store/toast';
import { undoServerAction } from '@/tasks/actions';
import { rememberActions } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
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
 * ChangedMark (design-system §10.3): a small emerald chat dot 14 with a glow and `caption` 600 «изменил помощник».
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
        <View
          style={[
            styles.dot,
            { backgroundColor: theme.colors.brand, shadowColor: theme.colors.brand, shadowOpacity: 0.6, shadowRadius: 5, shadowOffset: { width: 0, height: 0 }, elevation: 2 },
          ]}
        >
          <MessageCircleMore size={9} color={theme.colors.onBrand} strokeWidth={2.4} />
        </View>
        <AppText variant="caption" color="brand" style={{ fontFamily: theme.type.eyebrow.fontFamily }}>
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
          <Button testID="changed-undo" label={t('common.undo')} variant="secondary" disabled={busy} onPress={() => void undo()} />
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 14, height: 14, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
});
