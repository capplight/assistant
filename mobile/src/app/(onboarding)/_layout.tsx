import { Redirect, Stack } from 'expo-router';
import { useState } from 'react';

import { useOnboarding } from '@/store/onboarding';
import { useTheme } from '@/theme';

export default function OnboardingLayout() {
  // Only checked on entry: the last onboarding step navigates by itself after `complete()`.
  const [doneOnEntry] = useState(() => useOnboarding.getState().doneAt !== null);
  const theme = useTheme();
  if (doneOnEntry) return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.bg } }} />;
}
