import type { ActionOut } from '@/api/types';
import type { ChatMessage } from '@/store/assistant';

export type HistoryFilter = 'all' | 'changes' | 'questions' | 'waiting';

/** One line of «История»: what was said (null for a change made by hand) → what was done. */
export type HistoryEntry = {
  key: string;
  at: number;
  said: string | null;
  /** The assistant's answer (a chat turn), or null for a standalone action. */
  answer: ChatMessage | null;
  /** The action of the line: the turn's, or a standalone one. */
  action: ActionOut | null;
  kind: 'change' | 'question' | 'waiting';
};

/**
 * Builds «История» (Ф-50: «Переписка» + «Что я сделал» → one screen, design-system v2 HistoryItem): every turn of the
 * one conversation (what you said → what was done) and every change made without the line (a tick, a move by hand),
 * newest first. A turn's own action is shown inside the turn, never twice.
 */
export function historyEntries(messages: readonly ChatMessage[], actions: Record<string, ActionOut>): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const inTurns = new Set<string>();
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const q = m.replyTo ? byId.get(m.replyTo) : undefined;
    const action = m.action ? (actions[m.action.id] ?? null) : null;
    if (m.action) inTurns.add(m.action.id);
    const waiting = (!!m.proposal && !m.proposal.answered) || m.status === 'queued' || m.status === 'deferred';
    out.push({
      key: m.id,
      at: Date.parse(m.at) || 0,
      said: q?.text ?? null,
      answer: m,
      action,
      kind: waiting ? 'waiting' : m.action || m.saved ? 'change' : 'question',
    });
  }
  for (const a of Object.values(actions)) {
    if (a.undo_of || inTurns.has(a.id)) continue;
    if (a.message_id && messages.some((m) => m.serverId === a.message_id)) continue;
    out.push({ key: `a-${a.id}`, at: Date.parse(a.created_at ?? '') || 0, said: null, answer: null, action: a, kind: 'change' });
  }
  return out.sort((x, y) => y.at - x.at);
}

export const matchesFilter = (e: HistoryEntry, f: HistoryFilter) =>
  f === 'all' ? true : f === 'changes' ? e.kind === 'change' : f === 'questions' ? e.kind === 'question' : e.kind === 'waiting';

