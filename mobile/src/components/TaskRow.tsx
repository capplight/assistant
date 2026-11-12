import { Check, Ellipsis } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import type { TaskOut } from '@/api/types';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';

/**
 * One row with a box (2-design S12 / «Покупки»): the box is 32 pt, the whole row is the ≥56 pt
 * target and a `checkbox` for screen readers. Done rows are grey and crossed out; on «Покупки»
 * they also have «Вернуть». Works the same offline and in «Без ИИ».
 */
export function TaskRow({
  task,
  done,
  onToggle,
  showReturn,
  meta,
  onMenu,
  highlighted,
  box = 32,
  metaColor,
  big = false,
  qty,
}: {
  task: TaskOut;
  done: boolean;
  onToggle: () => void;
  showReturn?: boolean;
  meta?: string | null;
  /** «⋯ Ещё»: Выше / Ниже / Переместить… — the order on the page is the person's (F-41). */
  onMenu?: () => void;
  /** Just added by the assistant: `highlightTint` for 600 ms. */
  highlighted?: boolean;
  /** Week 11а: the planner's box is 40 pt (template-screens 2.3). */
  box?: number;
  /** Overdue: the line under the title in red, with words (not only colour). */
  metaColor?: 'danger';
  /** «Я в магазине»: `title1`, a 72 pt row, the whole row is the tick. */
  big?: boolean;
  /** «− 2 +» (Покупки) in place of « · 2» after the title. */
  qty?: ReactNode;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const title = task.qty ? `${task.title} · ${task.qty}` : task.title;
  const shownTitle = qty ? task.title : big && task.qty ? `${task.title}  ×${task.qty}` : title;
  const state = done ? t(task.list_key === 'shopping' ? 'tasks.bought' : 'tasks.done') : t('tasks.not_done');
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[2],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.separator,
        backgroundColor: highlighted ? theme.colors.highlightTint : undefined,
      }}
    >
      <Pressable
        testID={`task-${task.id}`}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={`${title}. ${state}`}
        onPress={onToggle}
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[3],
          minHeight: big ? 72 : theme.size.buttonHeight,
          paddingVertical: theme.space[2],
        }}
      >
        <View
          style={{
            width: big ? 44 : box,
            height: big ? 44 : box,
            borderWidth: 2,
            borderRadius: 6,
            alignItems: 'center',
            justifyContent: 'center',
            borderColor: done ? theme.colors.ink2 : theme.colors.iconSecondary,
            backgroundColor: done ? theme.colors.ink2 : theme.colors.surface,
          }}
        >
          {done ? <Check size={big || box > 32 ? 28 : 22} color={theme.colors.surface} strokeWidth={3} /> : null}
        </View>
        <View style={{ flex: 1 }}>
          <AppText
            variant={big ? 'title1' : 'body'}
            // «В магазине»: at most 2× `title1` (28 × 2 = 56 pt, the cap of template-screens 2.4).
            maxFontSizeMultiplier={big ? 2 : undefined}
            color={done ? 'ink2' : 'ink'}
            style={done ? { textDecorationLine: 'line-through' } : undefined}
          >
            {shownTitle}
          </AppText>
          {meta ? (
            <AppText variant="callout" color={metaColor ?? 'ink2'}>
              {meta}
            </AppText>
          ) : null}
        </View>
      </Pressable>
      {qty && !done ? qty : null}
      {done && showReturn ? (
        <Button
          testID={`task-return-${task.id}`}
          label={t('tasks.return')}
          accessibilityLabel={t('tasks.return_a11y', { title })}
          variant="text"
          minHeight={theme.size.minTouch}
          onPress={onToggle}
        />
      ) : null}
      {onMenu ? (
        <Pressable
          testID={`task-menu-${task.id}`}
          accessibilityRole="button"
          accessibilityLabel={t('tasks.menu_a11y', { title })}
          onPress={onMenu}
          style={{ width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ellipsis size={24} color={theme.colors.brand} />
        </Pressable>
      ) : null}
    </View>
  );
}
