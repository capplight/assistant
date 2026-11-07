import { fetch } from 'expo/fetch';
import { File } from 'expo-file-system';

import type { PutFile } from './endpoints';
import { ApiError, NetworkError } from './errors';

/** PUT the file bytes to the presigned URL (S3 in KZ; `/v1/dev/storage/…` with STORAGE_BACKEND=local). */
export const putFileNative: PutFile = async (uri, put) => {
  let res: Response;
  try {
    res = (await fetch(put.url, {
      method: put.method || 'PUT',
      headers: put.headers,
      body: new File(uri),
    })) as unknown as Response;
  } catch (e) {
    throw new NetworkError(e);
  }
  if (!res.ok) {
    // 403 = URL expired → the next attempt asks POST /uploads again for a fresh URL (retryable).
    throw new ApiError(res.status >= 500 || res.status === 403 ? 503 : res.status, { code: 'upload_put_failed' });
  }
};
