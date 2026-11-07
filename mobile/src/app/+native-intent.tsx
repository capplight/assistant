import { getShareExtensionKey } from 'expo-share-intent';

/**
 * The iOS share extension opens the app with `<scheme>://dataUrl=<scheme>ShareKey…`. That is not a
 * route — send it to the home screen; the ShareIntentProvider in the root layout picks the content up.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return '/';
    return path;
  } catch {
    return '/';
  }
}
