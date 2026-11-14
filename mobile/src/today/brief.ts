/**
 * «Сегодня» v2 — the morning briefing (design-system v2 §6, p14). Numbers are counted by code; the words are a
 * template from them (design-system §7: «если ответа нет, показываем шаблон»). Three parts of the day change the
 * status line and the headline, never the order of the blocks.
 */
export type DayPart = 'morning' | 'day' | 'evening';

export function dayPart(now: number): DayPart {
  const h = new Date(now).getHours();
  if (h < 12) return 'morning';
  return h < 18 ? 'day' : 'evening';
}

type T = (k: string, o?: Record<string, unknown>) => string;

export type BriefInput = {
  part: DayPart;
  /** Things to do today (rings + to-dos), and how many of them are done. */
  total: number;
  done: number;
  /** Timed items still ahead today, soonest first. */
  ahead: { title: string; time: string; inMinutes: number }[];
  /** «Потрачено 18 400 ₸», with what is left in the budget when one is set. */
  spent: string | null;
  left: string | null;
  /** Tomorrow's first item («Завтра в 10:00 звонок папе»). */
  tomorrow: { title: string; time: string } | null;
};

export type Brief = { status: string; headline: string; body: string };

export function briefOf(i: BriefInput, t: T): Brief {
  const open = i.total - i.done;
  const next = i.ahead[0];
  let status: string;
  let headline: string;
  if (i.part === 'morning') {
    status = t('brief.status_morning', { count: i.total });
    headline = i.total === 0 ? t('brief.free') : i.total <= 5 ? t('brief.calm') : t('brief.busy');
  } else if (i.part === 'day') {
    status = t('brief.status_day', { done: i.done, total: i.total });
    headline = next && next.inMinutes <= 60 ? t('brief.now', { title: lowerFirst(next.title) }) : i.total === 0 ? t('brief.free') : t('brief.in_progress');
  } else {
    status = t('brief.status_evening', { done: i.done, total: i.total });
    headline = i.total === 0 || i.done * 2 >= i.total ? t('brief.good') : t('brief.done_day');
  }
  const parts: string[] = [];
  if (i.part !== 'evening') {
    const timed = i.ahead.slice(0, 2).map((a, n) => (n === 0 ? t('brief.at_first', { title: a.title, time: a.time }) : t('brief.at_next', { title: lowerFirst(a.title), time: a.time })));
    if (i.part === 'day' && next && next.inMinutes <= 60) parts.push(t('brief.in_minutes', { n: Math.max(1, next.inMinutes), title: lowerFirst(next.title) }));
    else if (timed.length > 0) parts.push(`${timed.join(', ')}.`);
    else if (open > 0) parts.push(t('brief.open', { count: open }));
  } else if (open > 0) {
    parts.push(t('brief.left_open', { count: open }));
  }
  if (i.spent) parts.push(i.left ? t('brief.spent_left', { spent: i.spent, left: i.left }) : t('brief.spent', { spent: i.spent }));
  if (i.part === 'evening' && i.tomorrow) parts.push(t('brief.tomorrow', { time: i.tomorrow.time, title: lowerFirst(i.tomorrow.title) }));
  return { status, headline, body: parts.join(' ') };
}

const lowerFirst = (s: string) => (s.length > 1 && s[1] !== s[1]!.toUpperCase() ? s.charAt(0).toLowerCase() + s.slice(1) : s);
