import { ackLate, takeBackLateDone, unackLocal, type MissedRow } from '@/alarms/service';
import { getSyncEngine } from '@/services';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { undoServerAction } from '@/tasks/actions';
import { useTasks } from '@/tasks/store';

type T = (k: string, o?: Record<string, unknown>) => string;

/**
 * A missed ring ticked on «Сегодня»: a late `acked` (offline too) with «Отменить» in the toast — the same
 * behaviour as [Сделано] of the «Дела» list (`MissedList`), for the flat list of the day.
 */
export async function markMissedDone(row: MissedRow, t: T): Promise<void> {
  const late = await ackLate(row.key);
  if (!late) return;
  useUndo.getState().showCustom(t('missed.done_strip', { title: row.title }), () => {
    void (async () => {
      const back = await takeBackLateDone(row.key, late, await getSyncEngine());
      if (back.local) return; // never went
      const actionId =
        back.actionId ??
        Object.values(useTasks.getState().actions).find((x) => x.event_client_id === late.eventClientId)?.id ??
        null;
      const a = actionId ? useTasks.getState().actions[actionId] : undefined;
      if (!actionId || (a && (!a.undoable || a.undone_at))) {
        useToast.getState().show(t('missed.undo_gone'), 4000);
        return;
      }
      const r = await undoServerAction(actionId);
      if (r.result === 'done' || r.result === 'partial' || r.result === 'queued') unackLocal(row.key);
      else useToast.getState().show(t('changes.expired'), 4000);
    })();
  });
}
