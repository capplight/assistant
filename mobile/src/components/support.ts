import Constants from 'expo-constants';

/** Where «Помощь» / «Поддержка» go: `expo.extra.supportUrl` (a mailto: or https link). No link configured → no row. */
export function supportUrl(): string | null {
  const v = (Constants.expoConfig?.extra as { supportUrl?: unknown } | undefined)?.supportUrl;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
