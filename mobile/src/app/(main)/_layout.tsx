import { Redirect, Tabs } from 'expo-router';
import { KeyboardAvoidingView, Platform } from 'react-native';

import { MainFooter } from '@/components/MainFooter';
import { useOnboardingResumeHref } from '@/store/useOnboardingResume';

/**
 * Main area: page content on top; at the bottom — answer banner, assistant line and tabs on every page.
 * Uses the Tabs navigator only for state; the bar itself is custom (dynamic user pages, R-57).
 */
export default function MainLayout() {
  const resume = useOnboardingResumeHref();
  if (resume) return <Redirect href={resume} />;
  return (
    // iOS: keep the assistant line above the keyboard (Android resizes the window itself).
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Tabs screenOptions={{ headerShown: false, animation: 'none' }} tabBar={() => <MainFooter />}>
        <Tabs.Screen name="index" />
        <Tabs.Screen name="page/[id]" />
        <Tabs.Screen name="more" />
      </Tabs>
    </KeyboardAvoidingView>
  );
}
