import { Redirect, Tabs } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useAccount } from '@/account/data';
import { MainFooter } from '@/components/MainFooter';
import { AiConsentUpdate } from '@/consent/AiConsentUpdate';
import { finishWithDefaults } from '@/onboarding/service';
import { InTabsContext } from '@/store/chrome';
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
    // QA v5-device-3 J3: no KeyboardAvoidingView around the tabs — only the footer rides with the keyboard
    // (`MainFooter`, react-native-keyboard-controller); the screens never re-layout for it.
    <View style={{ flex: 1 }}>
      <InTabsContext.Provider value>
      <Tabs
        backBehavior="history"
        // L1: the scene paints nothing — the tray behind is the root stack's, the paper is the screen's.
        screenOptions={{ headerShown: false, animation: 'none', sceneStyle: { backgroundColor: 'transparent' } }}
        tabBar={() => <MainFooter />}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="page/[id]" />
        <Tabs.Screen name="more" />
        <Tabs.Screen name="records" />
        <Tabs.Screen name="record/[id]" />
        <Tabs.Screen name="plan/[id]" />
        <Tabs.Screen name="search" />
        <Tabs.Screen name="trash" />
        <Tabs.Screen name="my-pages" />
        <Tabs.Screen name="stack/[id]" />
        <Tabs.Screen name="duplicates" />
        <Tabs.Screen name="import" />
        <Tabs.Screen name="history" />
        <Tabs.Screen name="assistant" />
        <Tabs.Screen name="ai-import" />
        <Tabs.Screen name="ai-chats" />
      </Tabs>
      </InTabsContext.Provider>
      <AiConsentUpdate />
    </View>
  );
}
