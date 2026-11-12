import { act, renderRouter, screen, within } from 'expo-router/testing-library';
import * as Haptics from 'expo-haptics';
import { AccessibilityInfo } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

import { FEATURE_DEFAULTS, featuresOut } from '@/api/endpoints';
import { CheckCircle } from '@/components/ui';
import { getFeatures, refreshFeatures, useFeatureStore } from '@/store/features';
import { useToast } from '@/store/toast';
import { FEATURES_BODY, happyServer } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp } from '@/testing/helpers';

/** Beta scope switches (docs/api/features.md), confirmation toasts above the capsule, the check's haptic. */

describe('features', () => {
  it('offline before any answer: the founder’s decisions', async () => {
    resetApp();
    await refreshFeatures();
    expect(getFeatures()).toEqual(FEATURE_DEFAULTS);
    expect(FEATURE_DEFAULTS).toMatchObject({ board: false, statements_pdf: false, receipt_qr: false, consent_screen: 'welcome' });
    expect(FEATURE_DEFAULTS.today).toEqual({ tips_days: 7, tips_per_day: 1, proposals: false, tiles: false });
    expect(useFeatureStore.getState().fetchedAt).toBeNull();
  });

  it('reads GET /v1/features without sign-in and keeps the last answer when offline', async () => {
    const s = happyServer().on('GET /features', () => ({ status: 200, body: { ...FEATURES_BODY, board: true, today: { ...FEATURES_BODY.today, tips_days: 0 } } }));
    resetApp({ fetch: s.fetch });
    await refreshFeatures();
    expect(getFeatures().board).toBe(true);
    expect(getFeatures().today.tips_days).toBe(0);
    const call = s.calls.find((c) => c.path === '/features')!;
    expect(call.headers.Authorization ?? call.headers.authorization).toBeUndefined();
    s.offline = true;
    await refreshFeatures();
    expect(getFeatures().board).toBe(true);
  });

  it('decoder: odd or missing fields keep their default, unknown ones are ignored', () => {
    expect(featuresOut(null)).toEqual(FEATURE_DEFAULTS);
    const f = featuresOut({ board: 'yes', receipt_qr: true, today: { tips_per_day: -1, tiles: true }, pages: { first_use: [] }, extra: 1 });
    expect(f).toMatchObject({ board: false, receipt_qr: true, today: { tips_per_day: 1, tiles: true, tips_days: 7 }, pages: { first_use: [] } });
  });

  it('fetched at start by the root layout', async () => {
    const s = happyServer();
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: '/' });
    for (let i = 0; i < 5; i++) await act(async () => void (await jest.advanceTimersByTimeAsync(40)));
    expect(s.calls.some((c) => c.path === '/features')).toBe(true);
    expect(useFeatureStore.getState().fetchedAt).not.toBeNull();
  });
});

describe('confirmation toast above the capsule', () => {
  it('in the main area it is in the bottom column, right above the assistant line', async () => {
    resetApp();
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await act(async () => useToast.getState().show('Сохранено', 5000));
    expect(within(screen.getByTestId('footer-above-line')).getByTestId('toast')).toBeTruthy();
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
    expect(screen.getByText('Сохранено')).toBeTruthy();
  });
});

describe('CheckCircle haptic', () => {
  beforeEach(() => (Haptics.impactAsync as jest.Mock).mockClear());

  it('a light tick when checked, none when unchecking', async () => {
    await render(<CheckCircle testID="c" checked={false} onChange={() => undefined} label="Молоко" />);
    await fireEvent.press(screen.getByTestId('c'));
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
    await render(<CheckCircle testID="d" checked onChange={() => undefined} label="Хлеб" />);
    await fireEvent.press(screen.getByTestId('d'));
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
  });

  it('none with «Уменьшить движение»', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await render(<CheckCircle testID="c" checked={false} onChange={() => undefined} label="Молоко" />);
    await act(async () => undefined);
    await fireEvent.press(screen.getByTestId('c'));
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
