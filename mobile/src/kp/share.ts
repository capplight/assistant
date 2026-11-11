/**
 * Week 14: the PDF of a КП onto the phone and into the system «Поделиться» (3-engineering 6.8:
 * `expo-sharing`; the person picks the chat themselves). Behind a small port, loaded lazily, so
 * Jest never touches a native module.
 * Week 15 (S18): the mail app with the file attached (`expo-mail-composer`), and a link
 * (`wa.me/<номер>?text=` for the text alone). Nothing is ever sent by the app or the server: the
 * person presses ➤ themselves (decision №6, R-15).
 */

export type MailResult = 'sent' | 'saved' | 'cancelled' | 'unknown' | 'unavailable';
export type MailDraft = { recipients: string[]; subject: string; body: string; attachments: string[] };

export type SharePort = {
  /** The API file (with the session header) → a local file; returns its uri. */
  download(url: string, fileName: string, headers?: Record<string, string>): Promise<string>;
  /** The system share sheet with this file. */
  share(uri: string, mime: string, title: string): Promise<void>;
  /** The phone's mail app with the letter filled in; `unavailable` when no account is set up. */
  mail?(draft: MailDraft): Promise<MailResult>;
  /** Opens a link (WhatsApp's `wa.me`); false when nothing on the phone can open it. */
  openUrl?(url: string): Promise<boolean>;
  /** Week 16: a link (the archive of «Скачать мои данные») into the system share sheet. */
  shareLink?(url: string, message: string): Promise<void>;
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
    const UTI = mime === 'application/pdf' ? 'com.adobe.pdf' : mime.includes('wordprocessingml') ? 'org.openxmlformats.wordprocessingml.document' : undefined;
    await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: title, UTI });
  },
  async mail(draft) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Mail = require('expo-mail-composer') as typeof import('expo-mail-composer');
    if (!(await Mail.isAvailableAsync())) return 'unavailable';
    const r = await Mail.composeAsync(draft);
    // Android does not say what happened: «Отправили?» asks the person.
    return r.status === 'sent' || r.status === 'saved' || r.status === 'cancelled' ? r.status : 'unknown';
  },
  async shareLink(url, message) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Share } = require('react-native') as typeof import('react-native');
    // iOS shows `url` as the link; Android only sends `message`, so the link is in it too.
    await Share.share({ message: `${message}
${url}`, url });
  },
  async openUrl(url) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Linking } = require('react-native') as typeof import('react-native');
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      return false;
    }
  },
};

let override: SharePort | null = null;

export const getSharePort = (): SharePort => override ?? nativeShare;

export function setSharePortForTests(p: SharePort | null): void {
  override = p;
}
