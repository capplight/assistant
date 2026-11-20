import { router } from 'expo-router';

import type { ActionNoticeOut } from '@/api/types';
import { focusFromAssistant } from '@/calendar/service';
import { calState } from '@/calendar/store';
import { isoDate } from '@/calendar/time';
import { getRecords } from '@/db';
import { ensureTemplatePage } from '@/pages/service';
import { kickSync } from '@/services';
import { usePages } from '@/store/pages';
import { findTask } from '@/tasks/service';

type Target = NonNullable<ActionNoticeOut['target']>;

/** actions.md `notice.target.kind`, plus `calendar` and `budget` (chat-full-control §5). Others: no move at all. */
const KNOWN = new Set(['expense', 'task', 'document', 'reminder', 'item', 'page', 'calendar', 'budget']);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Where a tap on the notice of the assistant goes («Перенёс …», «Записал трату …»):
 * - `calendar` → the calendar on the day (`id` a date, or a to-do whose day it is; else today), the to-do rung;
 * - `task` with a day or a time → the same calendar day (a to-do without a day: the page, as before);
 * - `budget` / `expense` → «Расходы» (the page it names, else the one «Расходы»);
 * - `document` → the КП, `item` → the record card.
 * `handled`: the tap went somewhere; `page`: the caller opens the page as before; `none`: an unknown kind — stay.
 */
export async function openNoticeTarget(target: Target | null | undefined): Promise<'handled' | 'page' | 'none'> {
  if (!target) return 'page';
  if (!KNOWN.has(target.kind)) return 'none';
  switch (target.kind) {
    case 'calendar': {
      if (target.id && ISO_DAY.test(target.id)) return openCalendarDay(target.id);
      const t = target.id ? findTask(target.id) : undefined;
      return openCalendarDay(t ? (dayOf(t) ?? null) : null, t);
    }
    case 'task': {
      const t = target.id ? findTask(target.id) : undefined;
      const day = t && t.list_key === 'todo' && !t.deleted_at ? dayOf(t) : null;
      return day ? openCalendarDay(day, t) : 'page';
    }
    case 'budget':
    case 'expense': {
      const p = (target.page_id && usePages.getState().pages.find((x) => x.serverId === target.page_id)) || (await ensureTemplatePage('expenses'));
      if (!p) return 'page';
      router.navigate({ pathname: '/page/[id]', params: { id: p.id } });
      return 'handled';
    }
    case 'document':
      if (!target.id) return 'page';
      router.navigate({ pathname: '/kp/[id]', params: { id: target.id } });
      return 'handled';
    case 'item': {
      if (!target.id) return 'page';
      const rec = await (await getRecords()).findByServerId(target.id);
      if (rec) {
        router.navigate({ pathname: '/record/[id]', params: { id: rec.id } });
        return 'handled';
      }
      kickSync();
      return 'page';
    }
    default:
      return 'page';
  }
}

function dayOf(t: { start_at?: string | null; due_date: string | null }): string | null {
  const ms = t.start_at ? Date.parse(t.start_at) : NaN;
  return Number.isFinite(ms) ? isoDate(ms) : t.due_date;
}

function openCalendarDay(day: string | null, task?: Parameters<typeof focusFromAssistant>[0][number]): 'handled' | 'page' {
  const page = usePages.getState().pages.find((p) => p.templateKey === 'tasks');
  if (!page) return 'page';
  const today = isoDate(Date.now());
  const s = calState();
  // The list is not the calendar: open «День»; a calendar view already chosen stays (Ф-90).
  s.set({ view: s.view === 'list' ? 'day' : s.view, date: !day || day === today ? null : day });
  if (task) focusFromAssistant([task]);
  router.navigate({ pathname: '/page/[id]', params: { id: page.id } });
  return 'handled';
}
