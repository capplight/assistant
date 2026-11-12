import { CircleCheck, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from './Button';
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
 * Toast / undo strip (design-system §3): one line above the capsule, min 48, radius 20, `surfaceRaised` + floating
 * shadow; ✓ success · text · text buttons · ✕. At ≥150 % font the text takes its own line and the buttons wrap.
 * Timing (5 s, longer for a screen reader) belongs to the caller (`UndoStrip`, `ToastHost`).
 */
export function ToastBar({ text, success, actions = [], onClose, closeLabel, textTestID, style, testID }: Props) {
  const theme = useTheme();
  const column = theme.largeFont;
  return (
    <View
      testID={testID}
      accessibilityLiveRegion="polite"
      style={[
        styles.bar,
        {
          minHeight: theme.size.toastHeight,
          borderRadius: theme.radius.xl,
          backgroundColor: theme.colors.surfaceRaised,
          paddingLeft: theme.space[4],
          paddingRight: onClose ? 0 : theme.space[2],
          paddingVertical: theme.space[1],
          gap: theme.space[2],
          flexDirection: column ? 'column' : 'row',
          alignItems: column ? 'stretch' : 'center',
        },
        theme.elevation.floating,
        style,
      ]}
    >
      <View style={[styles.row, styles.grow, { gap: theme.space[2] }]}>
        {success ? <Icon icon={CircleCheck} size="sm" color="success" /> : null}
        <AppText testID={textTestID} variant="callout" color="ink" style={styles.grow}>
          {text}
        </AppText>
        {column && onClose ? <Close onPress={onClose} label={closeLabel} /> : null}
      </View>
      {actions.length > 0 || (!column && onClose) ? (
        <View style={[styles.row, styles.wrap]}>
          {actions.map((a) => (
            <Button
              key={a.key}
              testID={a.testID}
              label={a.label}
              accessibilityLabel={a.accessibilityLabel}
              variant="text"
              onPress={a.onPress}
            />
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
      <Icon icon={X} size="sm" color="iconSecondary" />
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
