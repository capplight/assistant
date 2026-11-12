import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

type Props = { onCode: (data: string) => void };

let override: ((p: Props) => React.ReactElement) | null = null;

/** Tests pass their own scanner (no native camera in Jest). */
export function setQrCameraForTests(c: ((p: Props) => React.ReactElement) | null): void {
  override = c;
}

/**
 * The live camera that reads a QR code on the phone itself (expo-camera's scanner: no network, no
 * model). Only QR codes are looked for; a frame in the middle shows where to hold the receipt.
 */
export function QrCamera(p: Props) {
  const theme = useTheme();
  const { t } = useTranslation();
  if (override) return override(p);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CameraView } = require('expo-camera') as typeof import('expo-camera');
  return (
    <View style={styles.flex} accessible accessibilityLabel={t('exp.qr_camera_a11y')}>
      <CameraView
        style={styles.flex}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={(r) => {
          if (r.data) p.onCode(r.data);
        }}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
        <View style={{ width: 240, height: 240, borderWidth: 4, borderColor: theme.colors.onBrand, borderRadius: theme.radius.lg }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
