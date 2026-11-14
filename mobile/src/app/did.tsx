import { Redirect } from 'expo-router';

/** «Что я сделал» is part of «История» now (Ф-50): its «Изменения» filter. */
export default function DidRedirect() {
  return <Redirect href={{ pathname: '/history', params: { tab: 'changes' } }} />;
}
