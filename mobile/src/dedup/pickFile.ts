/** One file the person chose in the system picker. */
export type PickedFile = { uri: string; name: string; mime: string | null; size: number | null };

export type FilePicker = () => Promise<PickedFile | null>;

let override: FilePicker | null = null;

/**
 * The system file picker (expo-document-picker), for the Telegram export: `result.json` or a zip.
 * Any type is allowed in the picker (Android often reports JSON as octet-stream); the name is
 * checked afterwards. Loaded lazily, so tests pass their own picker.
 */
export async function pickExportFile(): Promise<PickedFile | null> {
  if (override) return override();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const DocumentPicker = require('expo-document-picker') as typeof import('expo-document-picker');
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
  const a = res.canceled ? null : res.assets[0];
  return a ? { uri: a.uri, name: a.name, mime: a.mimeType ?? null, size: a.size ?? null } : null;
}

export function setFilePickerForTests(p: FilePicker | null): void {
  override = p;
}
