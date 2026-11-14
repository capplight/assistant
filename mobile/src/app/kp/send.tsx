import { Redirect, useLocalSearchParams } from 'expo-router';

/** Ф-50 «экраны КП 6 → 3»: «Отправить» is a sheet of the editor now; old links open it there. */
export default function KpSendRedirect() {
  const { doc } = useLocalSearchParams<{ doc: string }>();
  return <Redirect href={{ pathname: '/kp/[id]', params: { id: doc, sheet: 'send' } }} />;
}
