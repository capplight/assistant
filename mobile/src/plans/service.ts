import { useCallback, useEffect, useState } from 'react';

import { reminderSink } from '@/alarms/service';
import { useAlarms } from '@/alarms/store';
import { applyPatch } from '@/chat/service';
import i18n from '@/i18n';
import { getApi, kickSync } from '@/services';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import { rememberActions, taskSink } from '@/tasks/service';
import { newId } from '@/utils/id';

import type { PlanOut } from './types';

/** `GET /v1/plans/{id}` for the plan screen; `null` plan while loading, `error` when it could not be read. */
export function usePlan(id: string | undefined): {
  plan: PlanOut | null;
  error: boolean;
  reload: () => void;
  set: (p: PlanOut) => void;
} {
  const [state, setState] = useState<{ id: string | undefined; plan: PlanOut | null; error: boolean }>({
    id,
    plan: null,
    error: false,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    getApi()
      .getPlan(id)
      .then((plan) => {
        if (alive) setState({ id, plan, error: false });
      })
      .catch(() => {
        if (alive) setState((s) => ({ id, plan: s.id === id ? s.plan : null, error: true }));
      });
    return () => {
      alive = false;
    };
  }, [id, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const set = useCallback((plan: PlanOut) => setState({ id: plan.id, plan, error: false }), []);
  return { plan: state.id === id ? state.plan : null, error: state.id === id && state.error, reload, set };
}

/** «Отменить» of «Сделать делами»: the whole group, newest first (actions.md «Groups»). */
export async function undoPlanGroup(groupId: string): Promise<void> {
  try {
    const out = await getApi().undoActionGroup(groupId, newId());
    for (const patch of out.page_patches) await applyPatch(patch);
    rememberActions(out.undone.flatMap((u) => [u.action, u.undo].filter((x): x is NonNullable<typeof x> => !!x)));
    if (out.message_ru) useToast.getState().show(out.message_ru, 4000);
  } catch {
    useToast.getState().show(i18n.t('errors.generic'), 4000);
  } finally {
    kickSync();
  }
}

/**
 * plans.md «Сделать делами»: `POST /v1/plans/{id}/tasks` with a new `client_id`. The tasks and reminders come at once
 * (rings planned on the phone), the new rows are outlined, ONE notice from `group.notice` with «Отменить».
 */
export async function makePlanTasks(planId: string): Promise<PlanOut | null> {
  try {
    const out = await getApi().makePlanTasks(planId, newId());
    if (out.tasks.length > 0) taskSink.applyServer(out.tasks);
    if (out.reminders.length > 0) reminderSink.applyServer(out.reminders, [], useAlarms.getState().deviceId);
    for (const patch of out.page_patches) await applyPatch(patch);
    rememberActions(out.actions);
    const items = out.tasks.map((x) => x.item_id).filter((x): x is string => !!x);
    if (items.length > 0) useView.getState().showHighlight(items);
    const notice = out.group?.notice;
    const text =
      (i18n.language === 'kk' && notice?.text_kk) || notice?.text_ru || out.message_ru || i18n.t('plan.made');
    const groupId = out.group?.id;
    if (groupId) useUndo.getState().showCustom(text, () => void undoPlanGroup(groupId));
    else useToast.getState().show(text, 3000);
    kickSync();
    return out.plan;
  } catch {
    useToast.getState().show(i18n.t('errors.generic'), 4000);
    return null;
  }
}
