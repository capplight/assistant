import type { OutboxRepository } from '@/db/outbox';
import type { RecordsRepository } from '@/db/records';

export type VerifyPayload = {
  recordId: string;
  serverId: string;
  /** The seq the person was looking at. */
  baseSeq: number;
  /** Field key → the value they confirmed. */
  fields: Record<string, string | null>;
};

export type UnmergePayload = { recordId: string; serverId: string };

/**
 * Changes to a record: applied locally at once (overlay `pending`), sent by the outbox, so they
 * work offline and survive a restart.
 */
export class RecordActions {
  constructor(private readonly d: { records: RecordsRepository; outbox: OutboxRepository; onChanged?: () => void }) {}

  /** «Верно»: only this removes the «Проверьте» mark (R-36). */
  async verify(recordId: string, key: string): Promise<void> {
    const rec = await this.d.records.get(recordId);
    const field = rec?.reviewFields[key];
    if (!rec?.serverId || !field || field.state === 'verified') return;
    if (rec.pending.verify && key in rec.pending.verify) return; // double tap
    await this.d.records.setPending(rec.id, {
      ...rec.pending,
      verify: { ...rec.pending.verify, [key]: field.value },
    });
    const payload: VerifyPayload = {
      recordId: rec.id,
      serverId: rec.serverId,
      baseSeq: rec.seq,
      fields: { [key]: field.value },
    };
    await this.d.outbox.enqueue('item.verify', payload);
    this.d.onChanged?.();
  }

  /** «Отменить» on «Уже было — добавил к записи от …». */
  async unmerge(recordId: string): Promise<void> {
    const rec = await this.d.records.get(recordId);
    if (!rec?.serverId || rec.pending.unmerge) return;
    await this.d.records.setPending(rec.id, { ...rec.pending, unmerge: true });
    const payload: UnmergePayload = { recordId: rec.id, serverId: rec.serverId };
    await this.d.outbox.enqueue('item.unmerge', payload);
    this.d.onChanged?.();
  }
}
