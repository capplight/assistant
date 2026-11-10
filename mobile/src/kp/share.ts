/**
 * Week 14: the PDF of a КП onto the phone and into the system «Поделиться» (3-engineering 6.8:
 * `expo-sharing`; the person picks the chat themselves). Behind a small port, loaded lazily, so
 * Jest never touches a native module. Sending through WhatsApp / mail with «Отправили?» is week 15.
 */

export type SharePort = {
  /** The API file (with the session header) → a local file; returns its uri. */
  download(url: string, fileName: string, headers?: Record<string, string>): Promise<string>;
  /** The system share sheet with this file. */
  share(uri: string, mime: string, title: string): Promise<void>;
};

const safeName = (n: string) => n.replace(/[\\/:*?"<>|]+/g, '_').slice(-120) || 'KP.pdf';

const nativeShare: SharePort = {
  async download(url, fileName, headers) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Directory, File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
    const dir = new Directory(Paths.cache, 'kp');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const dest = new File(dir, safeName(fileName));
    if (dest.exists) dest.delete(); // a newer version of the same КП
    const file = await File.downloadFileAsync(url, dest, { headers: headers ?? {}, idempotent: true });
    return file.uri;
  },
  async share(uri, mime, title) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sharing = require('expo-sharing') as typeof import('expo-sharing');
    await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: title, UTI: mime === 'application/pdf' ? 'com.adobe.pdf' : undefined });
  },
};

let override: SharePort | null = null;

export const getSharePort = (): SharePort => override ?? nativeShare;

export function setSharePortForTests(p: SharePort | null): void {
  override = p;
}
