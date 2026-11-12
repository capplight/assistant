import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useToast } from '@/store/toast';
import { useLayout, useTheme } from '@/theme';

import { ToastBar } from './ui/ToastBar';

/**
 * Confirmation toast («Сохранено ✓»), design-system §3 Toast: one `ToastBar` right above the assistant capsule.
 * Where a capsule is on screen (main area, «Переписка») the bottom renders `<ToastLine />` in its column and
 * anchors it (`useToastAnchor`); elsewhere `ToastHost` shows the same bar at the bottom edge. The timer lives in
 * `ToastHost` (always mounted), so a toast never times out twice. Announced by screen readers (live region).
 */
export function ToastHost() {
  const toast = useToast((s) => s.toast);
  const hide = useToast((s) => s.hide);
  const anchored = useToast((s) => s.anchors > 0);
  const theme = useTheme();
  const layout = useLayout();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => hide(toast.id), toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast, hide]);

  if (!toast || anchored) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + theme.space[4], paddingHorizontal: theme.size.tabBarInset }]}>
      <View style={[styles.column, { maxWidth: layout.contentMaxWidth }]}>
        <ToastBar testID="toast" text={toast.text} success />
      </View>
    </View>
  );
}

/** The toast in a bottom column, right above the capsule (in flow: never covers the capsule or the keyboard). */
export function ToastLine({ style }: { style?: StyleProp<ViewStyle> }) {
  const toast = useToast((s) => s.toast);
  if (!toast) return null;
  return <ToastBar testID="toast" text={toast.text} success style={style} />;
}

/** A bottom with a capsule: while mounted, toasts go to its `ToastLine`. */
export function useToastAnchor(): void {
  useEffect(() => useToast.getState().anchor(), []);
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  column: { width: '100%' },
});
