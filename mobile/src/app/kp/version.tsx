import { Redirect, useLocalSearchParams } from 'expo-router';

/** Ф-50 «экраны КП 6 → 3»: one version is a sheet of the editor now; old links open it there. */
export default function KpVersionRedirect() {
  const { doc, n } = useLocalSearchParams<{ doc: string; n: string }>();
  return <Redirect href={{ pathname: '/kp/[id]', params: { id: doc, sheet: 'version', n } }} />;
}
