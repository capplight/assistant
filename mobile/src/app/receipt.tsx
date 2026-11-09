import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { QrCamera } from '@/components/page/QrCamera';
import { getMedia, type Permission } from '@/expenses/media';
import { saveReceipt, saveReceiptQr, saveStatement } from '@/expenses/receipts';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

type Kind = 'camera' | 'photo' | 'qr' | 'statement';

const KINDS = new Set<Kind>(['camera', 'photo', 'qr', 'statement']);

/**
 * Week 13: a receipt photo (camera / gallery), a fiscal QR, a statement PDF — from «Расходы» and
 * from «+» on that page. The camera is the only system prompt here, and it is explained first in
 * plain words (what for, that the person takes the picture themselves); when it is off in the phone's
 * settings the screen says so and offers the gallery instead. The QR is decoded right here, offline too.
 */
export default function ReceiptScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ kind?: string; page?: string }>();
  const kind: Kind = KINDS.has(params.kind as Kind) ? (params.kind as Kind) : 'camera';
  const page = params.page ?? null;
  const needsCamera = kind === 'camera' || kind === 'qr';
  const [perm, setPerm] = useState<Permission | null>(needsCamera ? null : 'granted');
  const [busy, setBusy] = useState(false);
  const [badQr, setBadQr] = useState(false);
  const started = useRef(false);
  const scanned = useRef(false);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else if (page) router.replace({ pathname: '/page/[id]', params: { id: page } });
    else router.replace('/');
  }, [page]);

  const pick = useCallback(
    async (k: 'camera' | 'photo' | 'statement') => {
      setBusy(true);
      try {
        const media = getMedia();
        const m = k === 'camera' ? await media.takePhoto() : k === 'photo' ? await media.pickPhoto() : await media.pickPdf();
        if (!m) return leave();
        if (k === 'statement') {
          const job = await saveStatement(m);
          router.replace({ pathname: '/statement/[id]', params: { id: job.id } });
          return;
        }
        await saveReceipt(m, page);
        leave();
      } catch (e) {
        console.warn('receipt pick failed', e);
        useToast.getState().show(t('exp.pick_failed'), 4000);
        leave();
      } finally {
        setBusy(false);
      }
    },
    [leave, page, t],
  );

  useEffect(() => {
    if (!needsCamera) return;
    let gone = false;
    const check = () =>
      void getMedia()
        .cameraPermission()
        .then((p) => {
          if (!gone) setPerm(p);
        });
    check();
    // Back from the phone's settings: look again.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => {
      gone = true;
      sub.remove();
    };
  }, [needsCamera]);

  // Granted (or nothing to grant): the camera / the picker opens at once, no extra tap.
  useEffect(() => {
    if (perm !== 'granted' || started.current || kind === 'qr') return;
    started.current = true;
    void pick(kind);
  }, [perm, kind, pick]);

  const allow = async () => setPerm(await getMedia().requestCamera());

  const onCode = async (data: string) => {
    if (scanned.current) return;
    scanned.current = true;
    const job = await saveReceiptQr(data);
    if (job) leave();
    else setBadQr(true);
  };

  if (kind === 'qr' && perm === 'granted' && !badQr) {
    return (
      <View testID="receipt-qr" style={[styles.root, { backgroundColor: theme.colors.bg }]}>
        <QrCamera onCode={(d) => void onCode(d)} />
        <View style={{ padding: theme.screenPadding, gap: theme.space[3], backgroundColor: theme.colors.surface }}>
          <AppText variant="title2" accessibilityRole="header" accessibilityLiveRegion="polite">
            {t('exp.qr_hint')}
          </AppText>
          <AppText variant="meta">{t('exp.qr_offline')}</AppText>
          <Button testID="receipt-qr-photo" label={t('exp.qr_take_photo')} variant="outline" onPress={() => void pick('camera')} />
          <Button testID="receipt-cancel" label={t('exp.cancel')} variant="text" onPress={leave} />
        </View>
      </View>
    );
  }

  const blocked = perm === 'blocked';
  return (
    <Screen testID="receipt-screen">
      <View style={{ gap: theme.space[4] }}>
        {badQr ? (
          <>
            <AppText variant="title1" accessibilityRole="header">
              {t('exp.qr_not_receipt_title')}
            </AppText>
            <AppText testID="receipt-qr-bad">{t('exp.qr_not_receipt')}</AppText>
            <Button
              testID="receipt-qr-again"
              label={t('exp.qr_again_scan')}
              onPress={() => {
                scanned.current = false;
                setBadQr(false);
              }}
            />
            <Button testID="receipt-cancel" label={t('exp.cancel')} variant="outline" onPress={leave} />
          </>
        ) : needsCamera && perm !== 'granted' && perm !== null ? (
          <>
            <AppText variant="title1" accessibilityRole="header">
              {t('exp.camera_title')}
            </AppText>
            <AppText testID="receipt-camera-why">{t(kind === 'qr' ? 'exp.camera_why_qr' : 'exp.camera_why')}</AppText>
            <AppText variant="meta">{t('exp.camera_private')}</AppText>
            {blocked ? (
              <>
                <AppText testID="receipt-camera-blocked" color="warnText">
                  {t('exp.camera_blocked')}
                </AppText>
                <Button testID="receipt-settings" label={t('exp.camera_settings')} onPress={() => getMedia().openSettings()} />
              </>
            ) : (
              <Button testID="receipt-allow" label={t('exp.camera_allow')} onPress={() => void allow()} />
            )}
            <Button testID="receipt-gallery" label={t('exp.from_gallery')} variant="outline" onPress={() => void pick('photo')} />
            <Button testID="receipt-cancel" label={t('exp.not_now')} variant="text" onPress={leave} />
          </>
        ) : (
          <AppText testID="receipt-busy" accessibilityLiveRegion="polite">
            {busy || perm === null ? t('exp.opening') : ''}
          </AppText>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
