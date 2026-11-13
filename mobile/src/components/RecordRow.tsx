import { ArrowDown, ArrowUp, Ellipsis } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native';

import type { LocalRecord } from '@/db';
import { recordTitle, sourceLine, statusLine } from '@/records/format';
import { unverifiedCount } from '@/records/review';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Icon } from './ui/Icon';
import { pressedStyle } from './ui/motion';

/** Week 7 controls of a row on a page (F-41): every gesture also has a visible button. */
export type RowMoves = {
  /** «⋯ Ещё» → the sheet with «Выше / Ниже / Переместить…». */
  onMenu: () => void;
  onUp?: () => void;
  onDown?: () => void;
  /** «Переместить на страницу…» for screen readers (custom action). */
  onMoveTo?: () => void;
  /** Long press 400 ms → drag (the double of the buttons). */
  onDragStart?: () => void;
  /** «Порядок»: ↑ ↓ on every card. */
  showArrows?: boolean;
};

/** One record in a list (S37 «Последние»). The card opens S09; «⋯» opens what can be done with it. */
export function RecordRow({
  record,
  onPress,
  snippet,
  highlighted,
  moves,
  lifted,
  onLayout,
}: {
  record: LocalRecord;
  onPress: () => void;
  /** Search: the place that matched, when the title does not show it. */
  snippet?: string | null;
  /** Just changed by the assistant: `highlightTint` for 600 ms (2-design `motion.highlight`). */
  highlighted?: boolean;
  moves?: RowMoves;
  /** Being dragged: raised with a shadow (2-design `motion.lift`). */
  lifted?: boolean;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const title = recordTitle(record, t);
  const source = sourceLine(record, i18n.language, t);
  const status = statusLine(record, t);
  const toCheck = unverifiedCount(record) > 0;

  // Screen readers: «Выше», «Ниже», «Переместить на страницу» on the card itself (2-design §8).
  const actions = moves
    ? [
        ...(moves.onUp ? [{ name: 'up', label: t('move.up') }] : []),
        ...(moves.onDown ? [{ name: 'down', label: t('move.down') }] : []),
        ...(moves.onMoveTo ? [{ name: 'moveTo', label: t('move.to') }] : []),
        { name: 'menu', label: t('move.menu') },
      ]
    : undefined;
  const onAction = (e: AccessibilityActionEvent) => {
    const name = e.nativeEvent.actionName;
    if (name === 'up') moves?.onUp?.();
    else if (name === 'down') moves?.onDown?.();
    else if (name === 'moveTo') moves?.onMoveTo?.();
    else if (name === 'menu') moves?.onMenu();
  };

  const square = {
    width: theme.size.minTouch,
    height: theme.size.minTouch,
    alignItems: 'center',
    justifyContent: 'center',
  } as const;

  return (
    <View
      testID={`record-card-${record.id}`}
      onLayout={onLayout}
      style={[
        styles.card,
        {
          backgroundColor: highlighted ? theme.colors.highlightTint : theme.colors.surface,
          borderRadius: theme.radius.lg,
          marginBottom: theme.space[2],
        },
        // design-system §3 Card: `surface` + the card shadow, no border; lifted = the floating shadow.
        lifted ? [theme.elevation.floating, { transform: [{ scale: 1.02 }] }] : theme.elevation.card,
      ]}
    >
      <Pressable
        testID={`record-${record.id}`}
        accessibilityRole="button"
        accessibilityLabel={[title, source, status, toCheck ? t('check.badge') : null].filter(Boolean).join('. ')}
        accessibilityHint={moves?.onDragStart ? t('move.drag_hint') : undefined}
        accessibilityActions={actions}
        onAccessibilityAction={actions ? onAction : undefined}
        onPress={onPress}
        onLongPress={moves?.onDragStart}
        delayLongPress={400}
        style={({ pressed }) => [
          styles.content,
          {
            backgroundColor: highlighted ? theme.colors.highlightTint : theme.colors.surface,
            borderRadius: theme.radius.lg,
            paddingVertical: theme.space[3],
            paddingHorizontal: theme.space[4],
            paddingRight: moves ? theme.space[1] : theme.space[4],
            minHeight: theme.size.rowHeightMeta,
            gap: 2,
          },
          pressedStyle(pressed),
        ]}
      >
        <AppText numberOfLines={3}>{title}</AppText>
        {snippet && snippet !== title ? <AppText variant="callout">{snippet}</AppText> : null}
        <AppText variant="footnote">{source}</AppText>
        {status ? <AppText variant="footnote">{status}</AppText> : null}
        {record.aiGenerated ? <AppText variant="footnote">{t('ai.label_short')}</AppText> : null}
        {toCheck ? (
          <View
            testID={`record-check-${record.id}`}
            style={[
              styles.badge,
              {
                backgroundColor: theme.colors.highlightTint,
                borderRadius: theme.radius.round,
                paddingHorizontal: theme.space[2],
              },
            ]}
          >
            <AppText variant="callout" color="warning">
              {t('check.badge')}
            </AppText>
          </View>
        ) : null}
      </Pressable>
      {moves ? (
        <View style={[styles.side, { paddingTop: theme.space[1], paddingRight: theme.space[1] }]}>
          <Pressable
            testID={`record-menu-${record.id}`}
            accessibilityRole="button"
            accessibilityLabel={t('move.menu_a11y', { what: title })}
            onPress={moves.onMenu}
            hitSlop={4}
            style={square}
          >
            <Icon icon={Ellipsis} size="sm" color="iconSecondary" />
          </Pressable>
          {moves.showArrows ? (
            <>
              <Pressable
                testID={`record-up-${record.id}`}
                accessibilityRole="button"
                accessibilityLabel={t('move.up_a11y', { what: title })}
                accessibilityState={{ disabled: !moves.onUp }}
                disabled={!moves.onUp}
                onPress={moves.onUp}
                style={[square, { opacity: moves.onUp ? 1 : 0.35 }]}
              >
                <Icon icon={ArrowUp} color="brand" />
              </Pressable>
              <Pressable
                testID={`record-down-${record.id}`}
                accessibilityRole="button"
                accessibilityLabel={t('move.down_a11y', { what: title })}
                accessibilityState={{ disabled: !moves.onDown }}
                disabled={!moves.onDown}
                onPress={moves.onDown}
                style={[square, { opacity: moves.onDown ? 1 : 0.35 }]}
              >
                <Icon icon={ArrowDown} color="brand" />
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row' },
  content: { flex: 1 },
  side: { alignItems: 'center' },
  badge: { alignSelf: 'flex-start' },
});
