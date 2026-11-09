import type { OutboxEntry } from '@/db';
import type { SyncDeps } from '@/sync/engine';

import { putPendingPlans, receiptSink, settleJobs } from './receipts';
import { applyServer, applyTombstone, expenseSink } from './service';

/** Everything «Расходы» takes from the sync engine: week 12's changes by hand and week 13's receipts and statements. */
export const expensesSink: NonNullable<SyncDeps['expenses']> = {
  send: (e: OutboxEntry) => (e.kind === 'expense.receipt' || e.kind === 'expense.statement' ? receiptSink.send(e) : expenseSink.send(e)),
  apply: (x) => {
    applyServer(x.entries, x.categories);
    settleJobs(x.entries);
    putPendingPlans(x.pending ?? []);
  },
  tombstone: applyTombstone,
};
