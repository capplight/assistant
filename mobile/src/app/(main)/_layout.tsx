import { Redirect, Tabs } from 'expo-router';
import { KeyboardAvoidingView, Platform } from 'react-native';

import { MainFooter } from '@/components/MainFooter';
import { useOnboarding } from '@/store/onboarding';
import { useSession } from '@/store/session';
import { useOnboardingResumeHref } from '@/store/useOnboardingResume';

/**
 * Main area: page content on top; at the bottom — answer banner, assistant line and tabs on every page.
 * Uses the Tabs navigator only for state; the bar itself is custom (dynamic user pages, R-57).
 */
export default function MainLayout() {
  const resume = useOnboardingResumeHref();
  const needsConsent = useOnboarding((s) => s.accountConsent !== null);
  const consentPostponed = useSession((s) => s.consentPostponed);
  const needsSignIn = useSession((s) => s.needsSignIn);
  const signInPostponed = useSession((s) => s.signInPostponed);
  if (resume) return <Redirect href={resume} />;
  // S04b and S05 come back at the next launch; until then the app works on this phone alone.
  if (needsSignIn && !signInPostponed) return <Redirect href="/phone?reason=expired" />;
  if (needsConsent && !consentPostponed) return <Redirect href="/account-consent" />;
  return (
    // iOS: keep the assistant line above the keyboard (Android resizes the window itself).
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Tabs screenOptions={{ headerShown: false, animation: 'none' }} tabBar={() => <MainFooter />}>
        <Tabs.Screen name="index" />
        <Tabs.Screen name="page/[id]" />
        <Tabs.Screen name="more" />
        <Tabs.Screen name="records" />
        <Tabs.Screen name="record/[id]" />
        <Tabs.Screen name="search" />
        <Tabs.Screen name="trash" />
      </Tabs>
    </KeyboardAvoidingView>
  );
}
