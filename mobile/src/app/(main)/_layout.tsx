import { Redirect, Tabs } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView } from 'react-native';

import { useAccount } from '@/account/data';
import { MainFooter } from '@/components/MainFooter';
import { KEYBOARD_BEHAVIOR } from '@/components/useKeyboard';
import { finishWithDefaults } from '@/onboarding/service';
import { useOnboarding } from '@/store/onboarding';
import { useSession } from '@/store/session';
import { useOnboardingResumeHref } from '@/store/useOnboardingResume';

/**
 * Main area: page content on top; at the bottom — answer banner, assistant line and tabs on every page.
 * Uses the Tabs navigator only for state; the bar itself is custom (dynamic user pages, R-57).
 */
export default function MainLayout() {
  // US-33 / Ф-34: consents recorded but the first launch not finished (closed right after «Начать», or on the old
  // S41 / S35 path) → «Сегодня» with the default set this time.
  useState(() => {
    const s = useOnboarding.getState();
    if (s.consent && !s.doneAt) void finishWithDefaults();
    return true;
  });
  const resume = useOnboardingResumeHref();
  const needsConsent = useOnboarding((s) => s.accountConsent !== null);
  const consentPostponed = useSession((s) => s.consentPostponed);
  const needsSignIn = useSession((s) => s.needsSignIn);
  const signInPostponed = useSession((s) => s.signInPostponed);
  const deleting = useAccount((s) => s.deleting !== null);
  if (deleting) return <Redirect href="/account-deleting" />;
  if (resume) return <Redirect href={resume} />;
  // S04b and S05 come back at the next launch; until then the app works on this phone alone.
  if (needsSignIn && !signInPostponed) return <Redirect href="/phone?reason=expired" />;
  if (needsConsent && !consentPostponed) return <Redirect href="/account-consent" />;
  return (
    // Keep the assistant line above the keyboard on both platforms: Android is edge-to-edge and no longer resizes (week 17).
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={KEYBOARD_BEHAVIOR}>
      <Tabs screenOptions={{ headerShown: false, animation: 'none' }} tabBar={() => <MainFooter />}>
        <Tabs.Screen name="index" />
        <Tabs.Screen name="page/[id]" />
        <Tabs.Screen name="more" />
        <Tabs.Screen name="records" />
        <Tabs.Screen name="record/[id]" />
        <Tabs.Screen name="search" />
        <Tabs.Screen name="trash" />
        <Tabs.Screen name="my-pages" />
        <Tabs.Screen name="stack/[id]" />
        <Tabs.Screen name="duplicates" />
        <Tabs.Screen name="import" />
      </Tabs>
    </KeyboardAvoidingView>
  );
}
