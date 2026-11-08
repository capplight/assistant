import { Check, Ellipsis } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import type { TaskOut } from '@/api/types';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

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
}: {
  task: TaskOut;
  done: boolean;
  onToggle: () => void;
  showReturn?: boolean;
  meta?: string | null;
  /** «⋯ Ещё»: Выше / Ниже / Переместить… — the order on the page is the person's (F-41). */
  onMenu?: () => void;
  /** Just added by the assistant: `markerSoft` for 600 ms. */
  highlighted?: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const title = task.qty ? `${task.title} · ${task.qty}` : task.title;
  const state = done ? t(task.list_key === 'shopping' ? 'tasks.bought' : 'tasks.done') : t('tasks.not_done');
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[2],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
        backgroundColor: highlighted ? theme.colors.markerSoft : undefined,
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
          minHeight: theme.size.primaryTouch,
          paddingVertical: theme.space[2],
        }}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderWidth: 2,
            borderRadius: 6,
            alignItems: 'center',
            justifyContent: 'center',
            borderColor: done ? theme.colors.ink2 : theme.colors.lineStrong,
            backgroundColor: done ? theme.colors.ink2 : theme.colors.surface,
          }}
        >
          {done ? <Check size={22} color={theme.colors.surface} strokeWidth={3} /> : null}
        </View>
        <View style={{ flex: 1 }}>
          <AppText color={done ? 'ink2' : 'ink'} style={done ? { textDecorationLine: 'line-through' } : undefined}>
            {title}
          </AppText>
          {meta ? <AppText variant="meta">{meta}</AppText> : null}
        </View>
      </Pressable>
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
          <Ellipsis size={24} color={theme.colors.accent} />
        </Pressable>
      ) : null}
    </View>
  );
}
