import { router } from 'expo-router';
import { create } from 'zustand';

import { reminderSink } from '@/alarms/service';
import { ApiError } from '@/api/errors';
import type { HabitOut, SuggestionOut, TodayOut } from '@/api/types';
import i18n from '@/i18n';
import { getPagesRepo } from '@/db';
import { getApi, syncBlocked } from '@/services';
import { syncPagesStore } from '@/store/pagesSync';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import { undoServerAction } from '@/tasks/actions';
import { rememberActions, taskSink } from '@/tasks/service';
import { tasksState } from '@/tasks/store';
import { newId } from '@/utils/id';

/**
 * S06 «Сегодня» (docs/api/today.md `GET /today`). The page is built on the phone from what it
 * holds (reminders and fires, tasks, actions), so it works offline and in «Без ИИ»; `/today`
 * adds what only the server knows — suggestions (tips ≤1, proposals ≤2), the order of sections,
 * the greeting — and its reminders, tasks and actions are merged into the phone's copy.
 * Called when the tab is shown (it runs the suggestion engine), never in the background.
 */
type TodayState = {
  last: TodayOut | null;
  /** Suggestions answered here (gone at once, before the server says so). */
  answered: string[];
  set: (p: Partial<Omit<TodayState, 'set'>>) => void;
};

export const useToday = create<TodayState>()((set) => ({
  last: null,
  answered: [],
  set: (p) => set(p),
}));

let loading: Promise<void> | null = null;

export function refreshToday(): Promise<void> {
  if (useOnboarding.getState().consent === null || syncBlocked()) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      try {
        const out = await getApi().today();
        const fires = [...out.today.reminders, ...out.missed].flatMap((r) => (r.fire ? [r.fire] : []));
        const reminders = [...out.today.reminders, ...out.missed].map((r) => r.reminder);
        if (reminders.length > 0 || fires.length > 0) reminderSink.applyServer(reminders, fires);
        taskSink.applyServer(out.today.tasks);
        rememberActions(out.done_for_you.actions);
        useToday.getState().set({ last: out });
      } catch {
        // offline: the phone's own copy is shown
      }
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

/**
 * /sync week 9 arrays: a suggestion answered on another phone or expired goes from «Сегодня»;
 * learned rules are kept for S30 (only `active` ones are shown).
 */
export function applySyncExtras(x: { suggestions: SuggestionOut[]; habits: HabitOut[] }): void {
  const gone = x.suggestions.filter((s) => ['accepted', 'dismissed', 'expired'].includes(s.status)).map((s) => s.id);
  if (gone.length > 0) {
    const st = useToday.getState();
    st.set({ answered: [...new Set([...st.answered, ...gone])] });
  }
  if (x.habits.length > 0) {
    const t = tasksState();
    const habits = { ...t.habits };
    for (const h of x.habits) if (!habits[h.id] || habits[h.id]!.seq <= h.seq) habits[h.id] = h;
    t.set({ habits });
  }
}

/** What is on screen now: the server's suggestions minus those just answered here. */
export function visibleSuggestions(last: TodayOut | null, answered: string[]): { proposals: SuggestionOut[]; tip: SuggestionOut | null } {
  if (!last) return { proposals: [], tip: null };
  const live = (s: SuggestionOut) => !answered.includes(s.id) && !['accepted', 'dismissed', 'expired'].includes(s.status);
  return { proposals: last.proposals.filter(live).slice(0, 2), tip: last.tip && live(last.tip) ? last.tip : null };
}

/** `do.type` the phone can carry out; anything else shows [Не сейчас] only (today.md). */
const DOABLE = new Set(['open_mic', 'put_phrase', 'link_phone', 'open_gallery']);
/** Done by the server on «Да» (week 16 adds the page proposals of R-55, onboarding.md). */
const PROPOSALS = new Set(['task_from_item', 'reminder_from_item', 'page_from_stack', 'add_documents_page']);

export function canSayYes(s: SuggestionOut): boolean {
  return PROPOSALS.has(s.key) || (!!s.do && DOABLE.has(s.do.type));
}

function answered(id: string): void {
  const st = useToday.getState();
  st.set({ answered: [...st.answered, id] });
}

/**
 * [Да]: the assistant never acts by itself — this tap is the «Да». A tip does what it says on the
 * phone (the person still sends the phrase); a proposal is done by the server with «Отменить».
 */
export async function sayYes(s: SuggestionOut): Promise<void> {
  const t = i18n.t.bind(i18n);
  if (!canSayYes(s)) return;
  answered(s.id);
  if (s.do?.type === 'open_mic') useView.getState().requestLine({ kind: 'mic' });
  if (s.do?.type === 'put_phrase' && s.do.phrase) {
    const page = s.do.page_id ? usePages.getState().pages.find((p) => p.serverId === s.do?.page_id) : undefined;
    if (page) router.navigate({ pathname: '/page/[id]', params: { id: page.id } });
    useView.getState().requestLine({ kind: 'text', text: s.do.phrase });
  }
  if (s.do?.type === 'link_phone') router.push('/phone');
  if (s.do?.type === 'open_gallery') router.push('/pages-gallery');
  try {
    const out = await getApi().acceptSuggestion(s.id, newId());
    if (out.task) taskSink.applyServer([out.task]);
    if (out.page) {
      // R-55 [Да]: the page is made; it shows as a tab at once and opens.
      const repo = await getPagesRepo();
      await repo.applyRemote(out.page);
      await syncPagesStore(repo);
      const local = usePages.getState().pages.find((p) => p.serverId === out.page?.id);
      if (local) router.navigate({ pathname: '/page/[id]', params: { id: local.id } });
    }
    if (out.action) {
      const action = out.action;
      rememberActions([action]);
      useUndo.getState().showCustom(
        (i18n.language === 'kk' && action.summary.kk) || action.summary.ru,
        () => void undoServerAction(action.id),
      );
    }
    const draft = out.reminder_draft;
    if (draft) {
      const params: Record<string, string> = { via: 'agent_suggestion' };
      const first = draft.draft ?? draft.options[0] ?? null;
      if (first) params.draft = JSON.stringify(first);
      if (draft.options.length > 1) params.options = JSON.stringify(draft.options);
      if (draft.message) params.message = draft.message;
      router.push({ pathname: '/reminder-new', params });
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 410) useToast.getState().show(e.messageRu || t('today.suggestion_gone'), 4000);
    else if (PROPOSALS.has(s.key)) {
      // The proposal is the server's to do: without it nothing happened, it can come again.
      const st = useToday.getState();
      st.set({ answered: st.answered.filter((x) => x !== s.id) });
      useToast.getState().show(t('today.suggestion_offline'), 4000);
    }
  }
}

/** [Не сейчас]: gone here at once; the server counts it (2× → 30 days for a tip). */
export async function sayNo(s: SuggestionOut): Promise<void> {
  answered(s.id);
  try {
    await getApi().dismissSuggestion(s.id);
  } catch {
    // shown again later by the server if the call never came; nothing to undo
  }
}
