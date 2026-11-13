import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';

import type { TaskOut } from '@/api/types';
import { useTheme, withAlpha } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
import { CheckMark } from './ui/Check';
import { useReducedMotion } from './ui/motion';

/**
 * One row with a round check (design-system §3 Checkbox + ListRow; «Дела», «Покупки»): the 24 circle, the whole
 * row is the target and a `checkbox` for screen readers (Bring!: one tap anywhere = done / bought). 52 high
 * (64 with a meta line), no border — a 0.5 inset divider. The menu (Выше / Ниже / Переместить…) opens on a long
 * press and as a screen-reader action; there is no «⋯» on the row. «Покупки»: the amount is text on the right
 * («2 шт», 15 ink2) and opens its own sheet on tap. Done rows are ink2 and crossed out; «Покупки» adds «Вернуть».
 */
export function TaskRow({
  task,
  done,
  onToggle,
  showReturn,
  meta,
  onMenu,
  highlighted,
  metaColor,
  big = false,
  qty,
  qtyLabel,
  onQty,
  separator = true,
}: {
  task: TaskOut;
  done: boolean;
  onToggle: () => void;
  showReturn?: boolean;
  meta?: string | null;
  /** «Ещё»: Выше / Ниже / Переместить… — long press and a screen-reader action (F-41). */
  onMenu?: () => void;
  /** Just added by the assistant: `highlightTint` for 600 ms. */
  highlighted?: boolean;
  /** @deprecated the circle is 24 everywhere now; kept so old call sites still compile. */
  box?: number;
  /** Overdue: the line under the title in red, with words (not only colour); the circle never turns red. */
  metaColor?: 'danger';
  /** «Я в магазине»: `title2`, a 64 row, high contrast; the whole row is the tick. */
  big?: boolean;
  /** Anything on the right instead of the amount text. */
  qty?: ReactNode;
  /** «Покупки»: the amount as text on the right («2 шт»). */
  qtyLabel?: string | null;
  /** Tap on the amount: the sheet with «− 2 +». */
  onQty?: () => void;
  /** The inset divider under the row (off for the last row of a group). */
  separator?: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const amount = qtyLabel ?? task.qty ?? null;
  const title = amount ? `${task.title} · ${amount}` : task.title;
  const shownTitle = big && amount ? `${task.title}  ×${amount}` : task.title;
  const state = done ? t(task.list_key === 'shopping' ? 'tasks.bought' : 'tasks.done') : t('tasks.not_done');
  const actions = onMenu ? [{ name: 'menu', label: t('move.menu') }] : undefined;
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'menu') onMenu?.();
  };
  const right = qty ?? (amount && !big && !done ? (
    onQty ? (
      <Pressable
        testID={`qty-${task.id}`}
        accessibilityRole="button"
        accessibilityLabel={t('shop.qty_change_a11y', { title: task.title, qty: amount })}
        onPress={onQty}
        style={({ pressed }) => [styles.qty, { minHeight: theme.size.minTouch, paddingHorizontal: theme.space[2] }, pressed && !reduced ? { opacity: 0.6 } : null]}
      >
        <AppText variant="callout">{amount}</AppText>
      </Pressable>
    ) : (
      <AppText testID={`qty-${task.id}`} variant="callout" style={{ paddingHorizontal: theme.space[2] }}>
        {amount}
      </AppText>
    )
  ) : null);
  return (
    <View
      style={[
        styles.row,
        {
          paddingLeft: theme.space[1],
          backgroundColor: highlighted ? theme.colors.highlightTint : undefined,
          borderRadius: highlighted ? theme.radius.sm : 0,
        },
      ]}
    >
      <Pressable
        testID={`task-${task.id}`}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={`${title}. ${state}`}
        accessibilityActions={actions}
        onAccessibilityAction={actions ? onAction : undefined}
        onPress={onToggle}
        onLongPress={onMenu}
        delayLongPress={400}
        style={({ pressed }) => [
          styles.main,
          {
            gap: theme.space[3],
            minHeight: big ? theme.size.rowHeightMeta : meta ? theme.size.rowHeightMeta : theme.size.rowHeight,
            paddingVertical: theme.space[2],
            backgroundColor: pressed ? withAlpha(theme.colors.surfaceSunken, 0.5) : 'transparent',
          },
        ]}
      >
        <CheckMark checked={done} />
        <View style={styles.flex}>
          <AppText
            variant={big ? 'title2' : 'body'}
            // «В магазине»: large and high contrast, capped at 2× (template-screens 2.4).
            maxFontSizeMultiplier={big ? 2 : undefined}
            color={done ? 'ink2' : 'ink'}
            style={[big ? { fontFamily: theme.type.headline.fontFamily } : null, done ? { textDecorationLine: 'line-through' } : null]}
          >
            {shownTitle}
          </AppText>
          {meta ? (
            <AppText variant="footnote" color={metaColor ?? 'ink2'}>
              {meta}
            </AppText>
          ) : null}
        </View>
      </Pressable>
      {right}
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
      {separator ? (
        <View
          style={[styles.divider, { left: theme.space[1] + theme.size.checkbox + theme.space[3], backgroundColor: theme.colors.separator }]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  qty: { alignItems: 'center', justifyContent: 'center' },
  divider: { position: 'absolute', right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
});
