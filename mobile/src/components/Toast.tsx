import { Check } from 'lucide-react-native';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

import { AppText } from './AppText';

/** Global confirmation toast, top of the screen, announced by screen readers (live region). */
export function ToastHost() {
  const toast = useToast((s) => s.toast);
  const hide = useToast((s) => s.hide);
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => hide(toast.id), toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast, hide]);

  if (!toast) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { top: insets.top + theme.space[3] }]}>
      <View
        testID="toast"
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={[
          styles.box,
          {
            backgroundColor: theme.colors.ink,
            borderRadius: theme.radius.card,
            paddingHorizontal: theme.space[4],
            paddingVertical: theme.space[3],
            gap: theme.space[2],
          },
        ]}
      >
        <Check size={20} color={theme.colors.bg} />
        <AppText variant="bodyStrong" style={{ color: theme.colors.bg }}>
          {toast.text}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  box: { flexDirection: 'row', alignItems: 'center', maxWidth: '90%' },
});
