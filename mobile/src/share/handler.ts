import type { LocalRecord } from '@/db/records';
import type { Capture } from '@/records/capture';

/** Subset of expo-share-intent's ShareIntent we use (kept local so the logic is testable without the module). */
export type SharedFile = {
  path: string;
  mimeType: string;
  fileName: string;
  size: number | null;
};

export type SharedContent = {
  type?: 'media' | 'file' | 'text' | 'weburl' | null;
  text?: string | null;
  webUrl?: string | null;
  files?: SharedFile[] | null;
};

/** Android gives plain paths, iOS file:// URLs — normalize to a URI expo-file-system accepts. */
export function toFileUri(path: string): string {
  if (/^[a-z]+:\/\//i.test(path)) return path;
  return `file://${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * «Поделиться» from any app (2-design §6.2, S22): every file becomes its own record, text/link
 * becomes a note/link record. With files, the shared text is kept as the files' note (text-only
 * annotation in the extension, R-43). Everything goes to the local DB + outbox — works offline.
 * Returns the records created (empty when there was nothing usable).
 */
export async function saveSharedContent(capture: Capture, share: SharedContent): Promise<LocalRecord[]> {
  const out: LocalRecord[] = [];
  const files = (share.files ?? []).filter((f) => f && f.path);
  const text = share.text?.trim() || '';
  const url = share.webUrl?.trim() || undefined;

  if (files.length > 0) {
    for (const f of files) {
      out.push(
        await capture.saveFile({
          uri: toFileUri(f.path),
          mime: f.mimeType || 'application/octet-stream',
          name: f.fileName,
          source: 'share',
          note: text || undefined,
        }),
      );
    }
    return out;
  }
  if (text || url) {
    out.push(await capture.saveText({ text: text || url!, url, source: 'share' }));
  }
  return out;
}
