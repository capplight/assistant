import type { ConsentsIn } from '@/api/types';
import { getOutbox, getPagesRepo, getRecords, type OutboxKind } from '@/db';
import { getApi, kickSync, notifyDataChanged } from '@/services';
import { useOnboarding, type ConsentRecord } from '@/store/onboarding';
import type { ConsentPayload, ItemPayload } from '@/sync/engine';

/** Rows that name the old account's ids or speak for it. Saved records and pages are not among them. */
const OLD_ACCOUNT_ONLY: readonly OutboxKind[] = [
  'consent.accept',
  'device.register',
  'item.verify',
  'item.unmerge',
  'item.correct',
  'item.delete',
  'item.restore',
  'profile.update',
  'action.undo',
  'page.item_move',
  'item.move_to_page',
  'page.item_remove',
  'pages.reorder',
  'pages.remove',
  'pages.restore',
  'task.update',
];

/**
 * The phone's records go with the person to the account the tokens are now for. Nothing here talks
 * to the server: the block in `syncBlocked()` holds until the caller lifts it.
 *
 * - The anonymous account on the server is not touched and keeps its copy (no merge exists, see
 *   docs/api/auth.md).
 * - Records it sent before: their captures are queued again under the same `client_id`, from the
 *   local files and text. Deleted records and hidden repeats stay out. A record with nothing local
 *   to send (a file that came from elsewhere) stays on this phone.
 * - Records never sent: their rows stay queued; a half-finished upload starts again, because the
 *   old account's upload id means nothing here.
 * - «Верно», «Исправить», «Удалить» and the like on the way name old ids: they are dropped, the
 *   overlay goes too. A deletion stays a deletion on this phone.
 * - Pages are created again; a topic the account already has adopts its page.
 *
 * Safe to repeat: rows are queued before the records lose their server ids, and a repeated row is
 * idempotent by `client_id`.
 */
export async function moveRecordsToThisAccount(): Promise<void> {
  const [outbox, records, pages] = await Promise.all([getOutbox(), getRecords(), getPagesRepo()]);

  const pendingRows = await outbox.listPending(Number.MAX_SAFE_INTEGER);
  for (const row of pendingRows) {
    if (OLD_ACCOUNT_ONLY.includes(row.kind)) await outbox.markFailed(row.id, 'account_switched');
    else if (row.kind === 'item.create') {
      const { uploadId: _old, ...p } = row.payload as ItemPayload;
      await outbox.updatePayload(row.id, p);
    }
  }

  const all = await records.list(Number.MAX_SAFE_INTEGER);
  const toSend = new Set(all.filter((r) => r.serverId !== null).map((r) => r.id));
  const requeued = new Set<string>();
  for (const row of await outbox.listSent('item.create')) {
    const { uploadId: _old, ...p } = row.payload as ItemPayload;
    const recordId = typeof p.sourceMeta?.recording_id === 'string' ? p.sourceMeta.recording_id : p.clientId;
    if (!toSend.has(recordId)) continue;
    await outbox.enqueue('item.create', { ...p, replay: true } satisfies ItemPayload);
    requeued.add(recordId);
  }
  for (const r of all) {
    if (!toSend.has(r.id) || requeued.has(r.id)) continue;
    const text = r.text ?? (r.kind === 'link' ? r.url : null);
    if (!text) continue; // only the old account has it; the record stays on this phone
    const payload: ItemPayload = {
      clientId: r.id,
      kind: r.kind === 'link' ? 'link' : 'note',
      source: 'typed',
      occurredAt: r.occurredAt,
      ...(r.kind === 'link' ? { url: text } : { text }),
      ...(r.pageId ? { pageId: r.pageId } : {}),
      replay: true,
    };
    await outbox.enqueue('item.create', payload);
    requeued.add(r.id);
  }

  const livePages = (await pages.listAll()).filter((p) => p.deletedAt === null && p.serverId !== null);
  if (livePages.length > 0) {
    await outbox.enqueue('pages.create', {
      pages: livePages.map(({ deletedAt: _d, hiddenAt: _h, titleDirty: _t, ...p }) => ({
        ...p,
        serverId: null,
        syncState: 'pending' as const,
        seq: 0,
      })),
    });
  }

  await pages.detachFromAccount();
  await records.detachFromAccount(requeued);
  await records.setCursor(0);
  notifyDataChanged();
}

/**
 * «Согласен» / «Без ИИ» on S05 for this account: only now anything may go to it. Consent first, then
 * the device (a switch gives a session with no device), then the moved records.
 */
export async function acceptAccountConsent(mode: ConsentRecord['mode'], request: ConsentsIn): Promise<void> {
  const onboarding = useOnboarding.getState();
  const pending = onboarding.accountConsent;
  const tokensUser = pending ? await getApi().client.tokens.getUserId() : null;
  // A crash between the block and the new tokens: the tokens are still the old account's.
  const moved = pending?.switched === true && tokensUser === pending.userId;
  if (moved) await moveRecordsToThisAccount();
  onboarding.acceptConsent(
    mode,
    request.consents.map((c) => ({ kind: c.kind, version: c.version, textHash: c.text_hash, locale: c.locale })),
  );
  const outbox = await getOutbox();
  const payload: ConsentPayload = { request, afterAccountSwitch: true };
  await outbox.enqueue('consent.accept', payload);
  await outbox.enqueue('device.register', {});
  onboarding.clearAccountConsent();
  kickSync();
}
