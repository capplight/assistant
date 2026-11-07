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

import { ToastHost } from '@/components/Toast';
import { usePushAnswers } from '@/push/usePushAnswers';
import { ShareIntentRoot } from '@/share/ShareIntentBridge';
import { useBackgroundSync } from '@/sync/useBackgroundSync';
import { useTheme } from '@/theme';

export { ErrorBoundary } from 'expo-router';

export default function RootLayout() {
  const [loaded, error] = useFonts({ Onest_400Regular, Onest_500Medium, Onest_600SemiBold, Onest_700Bold });
  const theme = useTheme();
  useBackgroundSync();
  usePushAnswers();

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
              primary: theme.colors.accent,
              border: theme.colors.line,
            },
          }}
        >
          <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.bg } }}>
            <Stack.Screen name="(main)" />
            <Stack.Screen name="(onboarding)" options={{ gestureEnabled: false }} />
            <Stack.Screen name="chat" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="phone" options={{ gestureEnabled: false }} />
            <Stack.Screen name="account-consent" options={{ gestureEnabled: false }} />
          </Stack>
          <ToastHost />
        </ThemeProvider>
      </SafeAreaProvider>
    </ShareIntentRoot>
  );
}
