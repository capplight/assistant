import { NetworkError, SignInRequiredError, ApiError } from '@/api/errors';
import type { ActionOut } from '@/api/types';
import { getOutbox } from '@/db';
import { getApi, getSyncEngine, kickSync } from '@/services';
import type { ActionUndoPayload } from '@/sync/engine';
import { newId } from '@/utils/id';

import { dropTick, rememberActions, setDone, showTick, taskSink, tickUndo, type TaskUpdatePayload } from './service';
import { tasksState } from './store';

export type UndoResult = 'done' | 'partial' | 'queued' | 'expired' | 'failed';

/**
 * «Отменить» of any action the server holds (S20 «Что я сделал», a suggestion's «Да», a removed
 * rule): POST /actions/{id}/undo; the server runs the recipe (actions.md). Offline the call waits
 * in the outbox with its `client_id` (a repeat returns the first result); the row shows as undone
 * here at once.
 */
export async function undoServerAction(actionId: string): Promise<{ result: UndoResult; message: string | null; undo: ActionOut | null }> {
  const clientId = newId();
  const mark = () => {
    const a = tasksState().actions[actionId];
    if (a) rememberActions([{ ...a, undoable: false, undone_at: new Date().toISOString() }]);
  };
  try {
    const out = await getApi().undoAction(actionId, { client_id: clientId });
    rememberActions([...(out.action ? [out.action] : []), ...(out.undo ? [out.undo] : [])]);
    kickSync();
    return { result: out.partial ? 'partial' : 'done', message: out.message_ru, undo: out.undo };
  } catch (e) {
    if (e instanceof NetworkError || e instanceof SignInRequiredError) {
      mark();
      const payload: ActionUndoPayload = { actionId, clientId };
      await (await getOutbox()).enqueue('action.undo', payload);
      return { result: 'queued', message: null, undo: null };
    }
    if (e instanceof ApiError && e.status === 410) {
      const a = tasksState().actions[actionId];
      if (a) rememberActions([{ ...a, undoable: false }]);
      return { result: 'expired', message: null, undo: null };
    }
    return { result: 'failed', message: null, undo: null };
  }
}

/** Kinds that always count as important, whoever did them: something gone, joined or brought in. */
const IMPORTANT_KINDS = new Set([
  'delete_item',
  'delete_screen',
  'hide_screen',
  'delete_stack',
  'merge_group',
  'cleanup_batch',
  'auto_merge_exact',
  'import_batch',
  'send_external',
]);

/**
 * S20 «Только важное» (rule chosen by mobile, founder 2026-11-09): what the assistant did by itself,
 * anything sent outside, and every deletion, merge of repeats and import. The person's own small
 * edits (moves, ticks, renames, moved reminders) are left out; «Все» shows them.
 */
export function isImportant(a: ActionOut): boolean {
  return a.initiated_by !== 'user' || a.scope === 'external' || IMPORTANT_KINDS.has(a.kind);
}

/** For S20: the undo action of an undone one («Вернуть» = undo the undo, actions.md `undo_of`). */
export function undoOf(actionId: string): ActionOut | undefined {
  return Object.values(tasksState().actions).find((a) => a.undo_of === actionId && a.undoable && !a.undone_at);
}

/** Tasks a suggestion's «Да» made show at once. */
export const showTasks = taskSink.applyServer;

/**
 * «Отменить» of a tick (today.md `POST /tasks/{id}/done`: the tick is an action). Still in the
 * outbox → it never goes. Sent → the undo of its action; the box shows the old state at once.
 * The server answered with no action (nothing changed there): nothing to undo but the screen.
 */
tickUndo.run = async (taskId, rowId, done, clientId) => {
  if (!rowId) {
    dropTick(taskId, clientId);
    return;
  }
  const outbox = await getOutbox();
  const engine = await getSyncEngine();
  await engine.hold(rowId);
  let actionId: string | null | undefined;
  try {
    const row = await outbox.get(rowId);
    if (!row || row.status === 'failed') return;
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone');
      dropTick(taskId, clientId);
      return;
    }
    actionId = (row.payload as TaskUpdatePayload).actionId;
  } finally {
    engine.release(rowId);
  }
  if (!actionId) {
    // An older server answered without an action: the only way back is the opposite tap.
    await setDone(taskId, !done, { strip: false });
    return;
  }
  showTick(taskId, !done);
  const r = await undoServerAction(actionId);
  if (r.result === 'expired' || r.result === 'failed') dropTick(taskId);
  kickSync();
};
