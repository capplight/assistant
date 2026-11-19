import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useChrome } from '@/store/chrome';
import { motion, reducedMotionFade, useTheme, type PlaceKey } from '@/theme';

import { AppText } from '../AppText';
import { Button } from './Button';
import { ListRow } from './Card';
import type { LucideIcon } from './Icon';
import { useReducedMotion } from './motion';

type SheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Pinned under the content (outside the scroll): the sheet's one main button. */
  footer?: ReactNode;
  /** A visible «Закрыть» next to the title (default on: closing must not depend on a swipe or the scrim). */
  closeButton?: boolean;
  /** Scrolls when taller than ~85 % of the window (default on). */
  scroll?: boolean;
  /** The place it was opened from (its 6 dp strip on top); default: the screen under it. */
  place?: PlaceKey;
  testID?: string;
};

/**
 * The one bottom sheet v5 (design-system §11.2 «Шторка»): `paper`, radius 28, a 6 dp strip in the colour of the
 * place it was opened from, a 40 × 5 `line2` grabber, the `scrim` that closes
 * on tap, ≤600 wide and centred on tablets, lifted above the keyboard on both platforms (edge-to-edge Android).
 * Reduced motion: fades instead of sliding.
 *
 * QA v5-device-3 J11 / D13: the modal itself does not animate (its `slide` dragged the scrim up with the sheet like a
 * curtain). The scrim fades in over 200 ms; the sheet rises from below on a spring (damping 24, stiffness 240), both on
 * the UI thread; closing plays them back before the modal goes. The navigation bar stays the app's (translucent).
 */
export const SHEET_SPRING = { damping: 24, stiffness: 240 } as const;
const SCRIM_MS = 200;
export function Sheet({ visible, onClose, title, children, footer, closeButton = true, scroll = true, place, testID }: SheetProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const fromPlace = useChrome((s) => s.place);
  const stripColor = theme.colors.place[place ?? fromPlace];
  // Mounted while open and while it closes (the way out plays before the modal goes).
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  const scrimP = useSharedValue(0);
  const rise = useSharedValue(height);
  useEffect(() => {
    if (visible) {
      scrimP.value = withTiming(1, { duration: reduced ? reducedMotionFade : SCRIM_MS });
      rise.value = reduced ? 0 : withSpring(0, SHEET_SPRING);
      return;
    }
    const gone = () => setMounted(false);
    scrimP.value = withTiming(0, { duration: reduced ? reducedMotionFade : motion.exit.duration }, (finished) => {
      'worklet';
      if (finished) runOnJS(gone)();
    });
    if (!reduced) rise.value = withTiming(height, { duration: motion.exit.duration, easing: Easing.bezier(0.3, 0, 1, 1) });
  }, [visible, reduced, height, scrimP, rise]);
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimP.value }));
  // Reduced motion: the sheet fades with the scrim instead of moving.
  const sheetStyle = useAnimatedStyle(() => (reduced ? { opacity: scrimP.value } : { transform: [{ translateY: rise.value }] }), [reduced]);
  const body = (
    <View style={{ gap: theme.space[3] }}>
      {children}
    </View>
  );
  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <View style={[styles.scrim, { paddingTop: Math.round(height * 0.08) }]}>
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.scrim }, scrimStyle]}
          />
          <Pressable
            testID={testID ? `${testID}-scrim` : undefined}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            importantForAccessibility="no"
            accessibilityElementsHidden
            onPress={onClose}
            style={StyleSheet.absoluteFill}
          />
          <Animated.View style={[styles.rise, sheetStyle]}>
          <SafeAreaView
            edges={['bottom']}
            testID={testID}
            style={[
              styles.sheet,
              {
                backgroundColor: theme.colors.paper,
                borderTopLeftRadius: theme.radius.sheet,
                borderTopRightRadius: theme.radius.sheet,
                maxWidth: theme.size.maxContentWidth,
                paddingHorizontal: theme.m.gutter,
                paddingBottom: theme.space[6],
                overflow: 'hidden',
              },
              { shadowColor: '#000000', shadowOffset: { width: 0, height: -10 }, shadowRadius: 30, shadowOpacity: 0.25, elevation: 16 },
            ]}
          >
            <View testID={testID ? `${testID}-strip` : undefined} style={{ height: 6, backgroundColor: stripColor, marginHorizontal: -theme.m.gutter }} />
            <View
              style={[
                styles.handle,
                {
                  width: theme.size.sheetHandle.width,
                  height: theme.size.sheetHandle.height,
                  backgroundColor: theme.colors.line2,
                  marginTop: 8,
                  marginBottom: 12,
                },
              ]}
            />
            {title || closeButton ? (
              <View style={[styles.head, { gap: theme.space[2], marginBottom: theme.space[2] }]}>
                {title ? (
                  <AppText variant="headline" accessibilityRole="header" style={[styles.flex, { fontSize: 21, lineHeight: 26 }]}>
                    {title}
                  </AppText>
                ) : (
                  <View style={styles.flex} />
                )}
                {closeButton ? (
                  <Button testID={testID ? `${testID}-close` : undefined} label={t('common.close')} variant="text" onPress={onClose} />
                ) : null}
              </View>
            ) : null}
            {scroll ? (
              <ScrollView style={styles.shrink} keyboardShouldPersistTaps="handled">
                {body}
              </ScrollView>
            ) : (
              body
            )}
            {footer ? <View style={{ paddingTop: theme.space[3], gap: theme.space[2] }}>{footer}</View> : null}
          </SafeAreaView>
          </Animated.View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export type SheetAction = {
  key: string;
  label: string;
  icon?: LucideIcon;
  onPress: () => void;
  /** Destructive: written in `danger`. */
  danger?: boolean;
  hint?: string;
  disabled?: boolean;
  testID?: string;
};

/** Actions of a sheet as rows, not a column of outline buttons (design-system §3 Sheet + ActionList). */
export function ActionList({ actions }: { actions: SheetAction[] }) {
  return (
    <View>
      {actions.map((a, i) => (
        <ListRow
          key={a.key}
          testID={a.testID}
          title={a.label}
          icon={a.icon}
          danger={a.danger}
          disabled={a.disabled}
          accessibilityHint={a.hint}
          onPress={a.onPress}
          separator={i < actions.length - 1}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexGrow: 0, flexShrink: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  // No maxHeight (it would cut text at 200 %): the scrim's top padding bounds it and the content scrolls.
  sheet: { width: '100%', flexShrink: 1 },
  rise: { width: '100%', flexShrink: 1, alignItems: 'center' },
  handle: { alignSelf: 'center', borderRadius: 3 },
  head: { flexDirection: 'row', alignItems: 'center' },
});
