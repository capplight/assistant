import '@/i18n';

import { Geologica_700Bold } from '@expo-google-fonts/geologica';
import {
  Onest_400Regular,
  Onest_500Medium,
  Onest_600SemiBold,
  Onest_700Bold,
  Onest_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/onest';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useAlarmsLifecycle } from '@/alarms/useAlarms';
import { ToastHost } from '@/components/Toast';
import { TopNoticeHost } from '@/components/UndoStrip';
import { usePushAnswers } from '@/push/usePushAnswers';
import { ShareAskHost } from '@/share/ShareAskHost';
import { useFeaturesLifecycle } from '@/store/features';
import { ShareIntentRoot } from '@/share/ShareIntentBridge';
import { useBackgroundSync } from '@/sync/useBackgroundSync';
import { useLayout, useTheme } from '@/theme';

export { ErrorBoundary } from 'expo-router';

export default function RootLayout() {
  const [loaded, error] = useFonts({ Onest_400Regular, Onest_500Medium, Onest_600SemiBold, Onest_700Bold, Onest_800ExtraBold, Geologica_700Bold });
  const theme = useTheme();
  useBackgroundSync();
  usePushAnswers();
  useAlarmsLifecycle();
  useFeaturesLifecycle();

  // Fall back to the system font if Onest / Geologica fail to load — never block the app on a font.
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
          {/* v4: «Отменить» lives at the top on every screen (design-system §10.2). */}
          <TopNoticeHost />
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
  useEffect(() => {
    // QA v2 §0.1: Android draws edge-to-edge; the system bar shows the root colour — the theme's `fade` — with light /
    // dark buttons. Imperative and Android-only (the declarative component re-applies on every render).
    if (Platform.OS !== 'android') return;
    void SystemUI.setBackgroundColorAsync(theme.colors.tray).catch(() => undefined);
    try {
      // The navigation bar lies on the tray (the tab bar): light buttons in both themes.
      NavigationBar.setStyle('light');
    } catch {
      // an old Android without the module: the bar keeps the system colour
    }
  }, [theme.colors.tray]);
  const side = landscape ? { paddingLeft: insets.left, paddingRight: insets.right } : null;
  return (
    <>
      {/* v5: the status bar sits on the dark tray in both themes. */}
      <StatusBar style="light" />

      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.tray, ...side } }}>
        <Stack.Screen name="(main)" />
        <Stack.Screen name="(onboarding)" options={{ gestureEnabled: false }} />
        <Stack.Screen name="chat" />
        {/* Ф-50 «КП: 3 экрана»: a new КП starts in a sheet over «Документы» (list · editor · send sheet). */}
        <Stack.Screen name="kp/new" options={{ presentation: 'formSheet', sheetAllowedDetents: [0.92], sheetGrabberVisible: true, sheetCornerRadius: 28 }} />
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
