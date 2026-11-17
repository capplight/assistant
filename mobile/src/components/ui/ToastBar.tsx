import { CircleCheck, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Icon } from './Icon';

export type ToastAction = { key: string; label: string; onPress: () => void; testID?: string; accessibilityLabel?: string };

type Props = {
  text: string;
  /** ✓ `success` before the text (a saved / done result). */
  success?: boolean;
  /** Text buttons in `brand`: «Отменить» always when it can be undone, «Показать», «Что изменилось». */
  actions?: ToastAction[];
  /** The ✕; without it the bar goes by its timer. */
  onClose?: () => void;
  closeLabel?: string;
  textTestID?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Toast v5: the same inverse capsule as the notice (`noticeBg`, radius 18, 600 15), above the assistant strip. With
 * actions it has two lines (min 72): ✓ text ✕ on top, the text buttons («Переложить · Отменить») bottom right; a plain
 * toast is one line (min 48). Timing (6 s, longer for a screen reader) belongs to the caller (`UndoStrip`, `ToastHost`).
 */
export function ToastBar({ text, success, actions = [], onClose, closeLabel, textTestID, style, testID }: Props) {
  const theme = useTheme();
  // Two lines only for two actions («Переложить · Отменить»); one action stays on the line (QA v2 §6.1).
  const column = theme.largeFont || actions.length > 1;
  return (
    <View
      testID={testID}
      accessibilityLiveRegion="polite"
      style={[
        styles.bar,
        {
          minHeight: actions.length > 1 ? theme.size.toastMinHeight : 54,
          borderRadius: 18,
          backgroundColor: theme.colors.noticeBg,
          paddingLeft: 16,
          paddingRight: onClose ? 0 : theme.space[2],
          paddingVertical: column ? theme.space[2] : theme.space[1],
          gap: column ? 0 : theme.space[2],
          flexDirection: column ? 'column' : 'row',
          alignItems: column ? 'stretch' : 'center',
        },
        { shadowColor: '#000000', shadowOffset: { width: 0, height: 14 }, shadowRadius: 30, shadowOpacity: 0.5, elevation: 12 },
        style,
      ]}
    >
      <View style={[styles.row, styles.grow, { gap: theme.space[2] }]}>
        {success ? <Icon icon={CircleCheck} size="md" color={theme.colors.noticeInk} /> : null}
        <AppText testID={textTestID} style={[styles.grow, { color: theme.colors.noticeInk, fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15, lineHeight: 19 }]}>
          {text}
        </AppText>
        {column && onClose ? <Close onPress={onClose} label={closeLabel} /> : column ? <View style={{ width: theme.space[2] }} /> : null}
      </View>
      {actions.length > 0 || (!column && onClose) ? (
        <View style={[styles.row, styles.wrap]}>
          {actions.map((a) => (
            <Pressable
              key={a.key}
              testID={a.testID}
              accessibilityRole="button"
              accessibilityLabel={a.accessibilityLabel ?? a.label}
              onPress={a.onPress}
              style={{ minHeight: theme.size.minTouch, justifyContent: 'center', paddingHorizontal: 10 }}
            >
              <AppText style={{ color: theme.colors.noticeInk, fontFamily: theme.type.title.fontFamily, fontSize: 15, lineHeight: 19, textDecorationLine: 'underline' }}>{a.label}</AppText>
            </Pressable>
          ))}
          {!column && onClose ? <Close onPress={onClose} label={closeLabel} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function Close({ onPress, label }: { onPress: () => void; label?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? t('common.close')}
      onPress={onPress}
      style={[styles.close, { width: theme.size.minTouch, height: theme.size.minTouch }]}
    >
      <Icon icon={X} size="sm" color={theme.colors.noticeInk} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {},
  row: { flexDirection: 'row', alignItems: 'center' },
  grow: { flexShrink: 1, flexGrow: 1 },
  wrap: { flexWrap: 'wrap', justifyContent: 'flex-end' },
  close: { alignItems: 'center', justifyContent: 'center' },
});
