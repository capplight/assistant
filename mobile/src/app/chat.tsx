import { Redirect, useLocalSearchParams } from 'expo-router';

/** «Переписка» is part of «История» now (Ф-50): old links, pushes and the banner land there, on the same answer. */
export default function ChatRedirect() {
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  return <Redirect href={focus ? { pathname: '/history', params: { focus } } : '/history'} />;
}
