import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { refreshCollections, refreshGroups } from '@/dedup/service';
import { usePages } from '@/store/pages';
import { listRows, localDate, type Segment } from '@/tasks/rows';
import '@/tasks/actions'; // the undo of a tick (registers `tickUndo`)
import { listsForPage } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import { MissedList, ReminderRows, Segments, useMinuteClock, useMissed } from '../ReminderLists';
import { StackCards } from '../StackCards';
import { EntryList } from './EntryList';
import { PageEmpty } from './PageEmpty';
import { fromList, withGroups, type Row } from './rows';
import type { ViewProps } from './registry';

/**
 * The week 3–10 middle of a page, kept as it was until each template gets its tool (week 11а:
 * «Заметки» stickers, «Дела» planner, «Покупки» fridge list; 12–14: «Расходы», «Документы»).
 * `simple`: «Простой список» (Ф-30), the fallback view of every template: the records in the
 * person's order (a task keeps its box), no tool parts around them.
 * «Покупки» / «Дела»: a record that is a task shows with a box; done ones go below, grey. «Дела»
 * also has Сегодня · Скоро · Пропущено with the reminders. «Заметки»: stacks, then «Последние».
 */
export function ClassicView({ page, entries, frameTop, ordering, simple = false }: ViewProps & { simple?: boolean }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hasShoppingPage = usePages((st) => st.pages.some((p) => p.templateKey === 'shopping'));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the lists follow the template and «Покупки» existing
  const lists = useMemo(() => listsForPage(page), [page.templateKey, hasShoppingPage]);
  const listMode = lists.length > 0;
  const tasksMap = useTasks((st) => st.tasks);
  const ticks = useTasks((st) => st.ticks);
  const [segment, setSegment] = useState<Segment>('today');
  const now = useMinuteClock();
  const missed = useMissed(now);
  const planner = page.templateKey === 'tasks' && !simple;
  const tasksSegment = planner ? segment : null;
  const today = localDate(now);

  // Week 10: stacks and «Объединить?» groups come with /sync; on «Заметки» ask once more when shown.
  const isNotes = page.templateKey === 'notes';
  useEffect(() => {
    if (!isNotes) return;
    void refreshCollections();
    void refreshGroups();
  }, [isNotes, page.id]);

  const rows = useMemo(() => {
    if (!listMode) return withGroups(entries ?? [], page.groups ?? []);
    const lr = listRows(entries ?? [], Object.values(tasksMap), ticks, { lists, segment: tasksSegment, today });
    const out: Row[] = lr.open.map(fromList);
    if (lr.done.length > 0) {
      out.push({ type: 'group', key: 'done', title: '' });
      out.push(...lr.done.map(fromList));
    }
    return out;
  }, [entries, page.groups, listMode, tasksMap, ticks, tasksSegment, today, lists]);

  const header = (
    <View style={{ marginBottom: theme.space[4], gap: theme.space[4] }}>
      {frameTop}
      {planner ? (
        <View style={{ gap: theme.space[3] }}>
          <Segments value={segment} onChange={setSegment} missedCount={missed.length} />
          {segment === 'missed' ? (
            missed.length > 0 ? (
              <MissedList rows={missed} now={now} />
            ) : (
              <AppText testID="missed-none">{t('tasks.missed_none')}</AppText>
            )
          ) : (
            <>
              <ReminderRows segment={segment} now={now} canDelete />
              <Button testID="tasks-new-reminder" label={t('today.new_reminder')} variant="secondary" onPress={() => router.push('/reminder-new')} />
            </>
          )}
        </View>
      ) : null}
      {!listMode && !simple ? <StackCards page={page} entries={entries} /> : null}
      {!listMode && !simple && entries && entries.length > 0 ? (
        <AppText variant="sectionLabel" accessibilityRole="header">
          {t('page.recent')}
        </AppText>
      ) : null}
    </View>
  );

  const example =
    page.templateKey === 'notes' || page.templateKey === 'custom'
      ? t(`page.empty_example.${page.templateKey}`)
      : t(`tpl.line_hint_now.${page.templateKey}`);

  return (
    <EntryList
      page={page}
      rows={rows}
      header={header}
      ordering={ordering}
      today={today}
      groupTitle={(g) =>
        listMode && g.key === 'done' ? t(page.templateKey === 'shopping' ? 'tasks.bought_section' : 'tasks.done_section') : g.title
      }
      empty={entries && !(planner && segment !== 'today') ? <PageEmpty lines={[t('page.empty'), example]} /> : null}
    />
  );
}

export function SimpleListView(props: ViewProps) {
  return <ClassicView {...props} simple />;
}
