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

export type CorrectPayload = {
  recordId: string;
  serverId: string;
  baseSeq: number;
  key: string;
  value: string;
  /** The value the person was correcting. */
  seen: string | null;
};

/** The record may not be on the server yet: its id is looked up when this is sent. */
export type TrashPayload = { recordId: string };

/**
 * Changes to a record: applied locally at once (overlay `pending`), sent by the outbox, so they
 * work offline and survive a restart.
 */
export class RecordActions {
  private readonly now: () => number;

  constructor(
    private readonly d: {
      records: RecordsRepository;
      outbox: OutboxRepository;
      onChanged?: () => void;
      now?: () => number;
    },
  ) {
    this.now = d.now ?? Date.now;
  }

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

  /** «Исправить»: the person's value replaces the recognized one and needs no more checking. */
  async correct(recordId: string, key: string, rawValue: string): Promise<void> {
    const rec = await this.d.records.get(recordId);
    const value = rawValue.split(/\s+/).filter(Boolean).join(' '); // one line, as the server keeps it
    const field = rec?.reviewFields[key];
    if (!rec?.serverId || !field || !value) return;
    if (value === (rec.pending.corrected?.[key] ?? field.value)) return;
    await this.d.records.setPending(rec.id, {
      ...rec.pending,
      corrected: { ...rec.pending.corrected, [key]: value },
    });
    const payload: CorrectPayload = {
      recordId: rec.id,
      serverId: rec.serverId,
      baseSeq: rec.seq,
      key,
      value,
      seen: field.value,
    };
    await this.d.outbox.enqueue('item.correct', payload);
    this.d.onChanged?.();
  }

  /** «Удалить»: to «Удалённые записи» for 30 days, nothing is lost at once. */
  async remove(recordId: string): Promise<void> {
    const rec = await this.d.records.get(recordId);
    if (!rec || rec.pending.deleted !== undefined) return;
    const { restored: _undone, ...pending } = rec.pending;
    await this.d.records.setPending(rec.id, { ...pending, deleted: this.now() });
    const payload: TrashPayload = { recordId: rec.id };
    await this.d.outbox.enqueue('item.delete', payload);
    this.d.onChanged?.();
  }

  /** «Вернуть» from «Удалённые записи», or «Отменить» right after deleting. */
  async restore(recordId: string): Promise<void> {
    const rec = await this.d.records.get(recordId);
    if (!rec || rec.pending.restored) return;
    const { deleted: _undone, ...pending } = rec.pending;
    await this.d.records.setPending(rec.id, { ...pending, restored: true });
    const payload: TrashPayload = { recordId: rec.id };
    await this.d.outbox.enqueue('item.restore', payload);
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
