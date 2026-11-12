import '@/i18n';

import {
  Onest_400Regular,
  Onest_500Medium,
  Onest_600SemiBold,
  Onest_700Bold,
  useFonts,
} from '@expo-google-fonts/onest';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAlarmsLifecycle } from '@/alarms/useAlarms';
import { ToastHost } from '@/components/Toast';
import { usePushAnswers } from '@/push/usePushAnswers';
import { ShareAskHost } from '@/share/ShareAskHost';
import { useFeaturesLifecycle } from '@/store/features';
import { ShareIntentRoot } from '@/share/ShareIntentBridge';
import { useBackgroundSync } from '@/sync/useBackgroundSync';
import { useLayout, useTheme } from '@/theme';

export { ErrorBoundary } from 'expo-router';

export default function RootLayout() {
  const [loaded, error] = useFonts({ Onest_400Regular, Onest_500Medium, Onest_600SemiBold, Onest_700Bold });
  const theme = useTheme();
  useBackgroundSync();
  usePushAnswers();
  useAlarmsLifecycle();
  useFeaturesLifecycle();

  // Fall back to the system font if Onest fails to load — never block the app on a font.
  if (!loaded && !error) return null;

  const nav = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
  return (
    <ShareIntentRoot>
      <SafeAreaProvider>
        <ThemeProvider
          value={{
            ...nav,
            colors: {
              ...nav.colors,
              background: theme.colors.bg,
              card: theme.colors.surface,
              text: theme.colors.ink,
              primary: theme.colors.brand,
              border: theme.colors.separator,
            },
          }}
        >
          <RootStack />
          <ShareAskHost />
          <ToastHost />
        </ThemeProvider>
      </SafeAreaProvider>
    </ShareIntentRoot>
  );
}

/**
 * Inside the safe-area provider: every screen gets the theme background and, in landscape, the side insets
 * (notch / camera cut-out), so no screen has to know about them (adaptive toolkit, `useLayout`).
 */
function RootStack() {
  const theme = useTheme();
  const { insets, landscape } = useLayout();
  const side = landscape ? { paddingLeft: insets.left, paddingRight: insets.right } : null;
  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.bg, ...side } }}>
        <Stack.Screen name="(main)" />
        <Stack.Screen name="(onboarding)" options={{ gestureEnabled: false }} />
        <Stack.Screen name="chat" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="phone" options={{ gestureEnabled: false }} />
        <Stack.Screen name="account-consent" options={{ gestureEnabled: false }} />
        <Stack.Screen name="alarm" options={{ presentation: 'fullScreenModal', gestureEnabled: false }} />
        <Stack.Screen name="alarm-setup" />
        <Stack.Screen name="reminder-new" options={{ presentation: 'modal' }} />
        <Stack.Screen name="notify" options={{ gestureEnabled: false }} />
        <Stack.Screen name="page-settings/[id]" />
        <Stack.Screen name="receipt" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="statement/[id]" />
      </Stack>
    </>
  );
}
