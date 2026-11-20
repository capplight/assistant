import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useAlarms } from '@/alarms/store';
import { shownTask } from '@/tasks/edit';
import { isDone } from '@/tasks/service';
import { useTasks } from '@/tasks/store';

import { buildEntries, type CalEntry } from './entries';
import { ensureCalendarLoaded } from './service';
import { useCalendar } from './store';

/** The calendar entries of [from, to] from everything this phone holds (re-counted only when a source changes). */
export function useCalendarEntries(from: string, to: string): CalEntry[] {
  const tasks = useTasks((s) => s.tasks);
  const ticks = useTasks((s) => s.ticks);
  const edits = useTasks((s) => s.edits);
  const alarms = useAlarms(useShallow((s) => ({ reminders: s.reminders, fires: s.fires, local: s.local })));
  const cal = useCalendar(
    useShallow((s) => ({ occurrences: s.occurrences, timeEdits: s.timeEdits, occEdits: s.occEdits, seriesEnds: s.seriesEnds, server: s.server })),
  );
  useEffect(() => {
    void ensureCalendarLoaded();
  }, []);
  return useMemo(
    () =>
      buildEntries(
        {
          tasks,
          isDone: (t) => isDone(t, ticks),
          dueOf: (t) => shownTask(t, edits).due_date,
          reminders: alarms.reminders,
          fires: alarms.fires,
          acked: (k) => !!alarms.local[k]?.ackedAt,
          ...cal,
        },
        from,
        to,
      ),
    [tasks, ticks, edits, alarms, cal, from, to],
  );
}
