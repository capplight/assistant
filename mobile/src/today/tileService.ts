import { getOutbox, getPagesRepo } from '@/db';
import type { PageLook } from '@/db/pages';
import i18n from '@/i18n';
import type { TodayTile } from '@/pages/viewModel';
import { lookOf } from '@/pages/viewService';
import { getSyncEngine, kickSync, notifyDataChanged } from '@/services';
import { usePages, type Page } from '@/store/pages';
import { useUndo } from '@/store/undo';
import type { TodayTilePayload } from '@/sync/engine';
import { undoServerAction } from '@/tasks/actions';
import { newId } from '@/utils/id';

import { useToday } from './service';

/**
 * Week 16: «Всегда показывать на Сегодня / Не показывать» on a tile (onboarding.md
 * `PUT /pages/{id}/today-tile`). Shown at once (offline too), sent through the outbox; «Отменить»:
 * still waiting → dropped, sent → the undo of its action.
 */

const nameOf = (p: Page) => p.title ?? i18n.t(p.templateKey === 'custom' ? 'tpl.custom_default' : `tpl.${p.templateKey}`);

async function show(pageId: string, mode: TodayTile): Promise<void> {
  const page = usePages.getState().pages.find((p) => p.id === pageId);
  if (!page) return;
  const look = lookOf(page);
  const next = { ...look, view: { ...look.view, todayTile: mode } };
  usePages.getState().setLook(pageId, next);
  await (await getPagesRepo()).setLook(pageId, next as PageLook, false);
  // The server's tiles of the last /today are now old for this page: take its tile away / keep it.
  const last = useToday.getState().last;
  if (last && mode === 'hidden') {
    useToday.getState().set({ last: { ...last, page_tiles: last.page_tiles.filter((x) => x.page_id !== page.serverId) } });
  }
  notifyDataChanged();
}

export async function setTodayTile(page: Page, mode: TodayTile): Promise<void> {
  const before = page.view?.todayTile ?? 'auto';
  if (before === mode) return;
  await show(page.id, mode);
  const payload: TodayTilePayload = { pageId: page.id, mode, before, clientId: newId() };
  const row = await (await getOutbox()).enqueue('page.today_tile', payload);
  useUndo.getState().showCustom(i18n.t(`view.tile_${mode}`, { page: nameOf(page) }), () => void undoTodayTile(row.id));
  kickSync();
}

export async function undoTodayTile(outboxId: string): Promise<void> {
  const engine = await getSyncEngine();
  await engine.hold(outboxId);
  try {
    const outbox = await getOutbox();
    const row = await outbox.get(outboxId);
    if (!row || row.status === 'failed') return;
    const p = row.payload as TodayTilePayload;
    await show(p.pageId, p.before);
    if (row.status === 'pending') await outbox.markFailed(row.id, 'undone');
    else if (p.actionId) await undoServerAction(p.actionId);
  } finally {
    engine.release(outboxId);
    kickSync();
  }
}
