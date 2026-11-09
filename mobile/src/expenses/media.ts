import { Linking } from 'react-native';

/**
 * Week 13: the camera, the photo library and the file picker for «Расходы» (3-engineering 2.1
 * «Камера/скан»: `expo-image-picker`, `expo-camera`; JPEG ≤2048 px q0.8, no EXIF location).
 * Behind a small port, loaded lazily, so tests pass their own and Jest never touches a native module.
 *
 * Permissions (binding: explained in plain words before the system asks): only the camera has a
 * system prompt here. The photo library (PHPicker on iOS 14+, the Android photo picker) and the file
 * picker show only what the person picks and ask nothing.
 */

export type Permission = 'granted' | 'undetermined' | 'denied' | 'blocked';

export type PickedMedia = { uri: string; mime: string; name: string };

export type MediaPort = {
  cameraPermission(): Promise<Permission>;
  requestCamera(): Promise<Permission>;
  /** The system camera; null when the person closed it. The photo is already shrunk, without EXIF. */
  takePhoto(): Promise<PickedMedia | null>;
  pickPhoto(): Promise<PickedMedia | null>;
  /** A PDF (a statement, a receipt from the bank). */
  pickPdf(): Promise<PickedMedia | null>;
  openSettings(): void;
};

/** The longest side of a receipt photo (3-engineering 2.1). */
export const MAX_SIDE = 2048;
export const JPEG_QUALITY = 0.8;

type PermLike = { granted: boolean; canAskAgain: boolean; status: string };
const toPermission = (p: PermLike): Permission =>
  p.granted ? 'granted' : p.status === 'undetermined' ? 'undetermined' : p.canAskAgain ? 'denied' : 'blocked';

/** Re-encoded through the image manipulator: at most 2048 px, JPEG q0.8 — this also drops EXIF (location). */
async function shrink(uri: string, width: number, height: number): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ImageManipulator, SaveFormat } = require('expo-image-manipulator') as typeof import('expo-image-manipulator');
  const ctx = ImageManipulator.manipulate(uri);
  const side = Math.max(width, height);
  if (side > MAX_SIDE) ctx.resize(width >= height ? { width: MAX_SIDE } : { height: MAX_SIDE });
  const img = await ctx.renderAsync();
  const out = await img.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });
  return out.uri;
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const nativeMedia: MediaPort = {
  async cameraPermission() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Camera } = require('expo-camera') as typeof import('expo-camera');
    return toPermission(await Camera.getCameraPermissionsAsync());
  },
  async requestCamera() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Camera } = require('expo-camera') as typeof import('expo-camera');
    return toPermission(await Camera.requestCameraPermissionsAsync());
  },
  async takePhoto() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ImagePicker = require('expo-image-picker') as typeof import('expo-image-picker');
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false, allowsEditing: false });
    const a = res.canceled ? null : res.assets[0];
    if (!a) return null;
    return { uri: await shrink(a.uri, a.width, a.height), mime: 'image/jpeg', name: `receipt-${stamp()}.jpg` };
  },
  async pickPhoto() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ImagePicker = require('expo-image-picker') as typeof import('expo-image-picker');
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false, allowsMultipleSelection: false });
    const a = res.canceled ? null : res.assets[0];
    if (!a) return null;
    return { uri: await shrink(a.uri, a.width, a.height), mime: 'image/jpeg', name: `receipt-${stamp()}.jpg` };
  },
  async pickPdf() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const DocumentPicker = require('expo-document-picker') as typeof import('expo-document-picker');
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/pdf'], copyToCacheDirectory: true, multiple: false });
    const a = res.canceled ? null : res.assets[0];
    return a ? { uri: a.uri, mime: a.mimeType ?? 'application/pdf', name: a.name } : null;
  },
  openSettings() {
    void Linking.openSettings();
  },
};

let override: MediaPort | null = null;

export const getMedia = (): MediaPort => override ?? nativeMedia;

export function setMediaForTests(m: MediaPort | null): void {
  override = m;
}
