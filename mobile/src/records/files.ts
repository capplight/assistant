import { Directory, File, Paths } from 'expo-file-system';

import type { FileOps } from './capture';

/** Originals waiting for upload live here (document dir — not cleared by the system like the cache). */
function recordsDir(): Directory {
  const dir = new Directory(Paths.document, 'records');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export const nativeFileOps: FileOps = {
  async persist(srcUri, name) {
    const src = new File(srcUri);
    const dest = new File(recordsDir(), name);
    if (dest.exists) return dest.uri; // retried save of the same record
    await src.copy(dest);
    return dest.uri;
  },
  async size(uri) {
    return new File(uri).size ?? 0;
  },
  async sha256(uri) {
    return new File(uri).digest('SHA-256');
  },
};
