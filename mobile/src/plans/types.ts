/** docs/api/plans.md («Составь план», step 8). */

export type PlanKind = 'trip' | 'actions';

export type PlanCardRow = { n: number; date: string | null; title: string; points: number | null; due_date: string | null; after_n: number[]; note: string | null };

/** The card of the chat (event `plan`, `Action.plan`). */
export type PlanCardOut = {
  item_id: string;
  kind: PlanKind;
  title: string;
  subtitle: string | null;
  lead: string | null;
  rows: PlanCardRow[];
  start_date: string | null;
  end_date: string | null;
  page: { page_id: string; title: string } | null;
  check_note: string | null;
  can_make_tasks: boolean;
  action_id: string | null;
  edited: boolean;
};

export type PlanPoint = { id: string; title: string; note: string | null; source_id: string | null; own: boolean; place: string | null };
export type PlanDay = { n: number; date: string | null; title: string | null; points: PlanPoint[] };
export type PlanStep = {
  id: string;
  n: number;
  title: string;
  note: string | null;
  due_date: string | null;
  after: string[];
  remind_at: string | null;
  source_id: string | null;
  own: boolean;
  task_id: string | null;
  task: { id: string; done: boolean; due_date: string | null } | null;
};
export type PlanSource = { item_id: string; title: string | null; kind: string | null; created_at: string | null; occurred_at: string | null; available: boolean };

export type PlanOut = {
  id: string;
  kind: PlanKind;
  title: string;
  start_date: string | null;
  end_date: string | null;
  days: PlanDay[];
  steps: PlanStep[];
  sources: PlanSource[];
  asked: string | null;
  can_make_tasks: boolean;
  check_note: string | null;
  pages: { page_id: string; title: string }[];
};
