import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CalEntry } from '@/calendar/entries';
import { deleteEntry, moveEntry, setEntryDone, setReminderOffset, setRepeat } from '@/calendar/service';
import { changeTask } from '@/tasks/edit';

import { EntrySheet, ScopeSheet } from './Sheets';

/**
 * The one card of a to-do for the whole app (§2: the grid, the plan on «Сегодня», the list, the chat): A5 wired to the
 * calendar's changes, with «Только это / Это и следующие» for an occurrence of a repeat.
 */
export function EntryCard({ entry, onClose }: { entry: CalEntry; onClose: () => void }) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<{ kind: 'move' | 'delete'; to?: { start: number; duration: number | null } } | null>(null);
  if (scope) {
    return (
      <ScopeSheet
        kind={scope.kind}
        onClose={onClose}
        onPick={(s) => {
          onClose();
          if (scope.kind === 'delete') void deleteEntry(entry, s);
          else if (scope.to) void moveEntry(entry, { date: entry.date, ...scope.to }, s);
        }}
      />
    );
  }
  return (
    <EntrySheet
      entry={entry}
      onClose={onClose}
      onRename={(title) => void changeTask(entry.id, { title }, t('cal.renamed', { title }))}
      onTime={(to) => {
        if (entry.occurrenceAt) return setScope({ kind: 'move', to });
        onClose();
        void moveEntry(entry, { date: entry.date, ...to });
      }}
      onRepeat={(rrule) => void setRepeat(entry, rrule)}
      onDone={() => {
        onClose();
        void setEntryDone(entry, !entry.done);
      }}
      onDelete={() => {
        if (entry.occurrenceAt) return setScope({ kind: 'delete' });
        onClose();
        void deleteEntry(entry);
      }}
      onRemind={(offset) => void setReminderOffset(entry, offset)}
    />
  );
}
