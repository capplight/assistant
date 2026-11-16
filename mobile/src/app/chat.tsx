import { Redirect, useLocalSearchParams } from 'expo-router';

/** «Переписка» is the centre «Помощник» tab now (VISION-2026-11): old links and pushes land there, on the same answer. */
export default function ChatRedirect() {
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  return <Redirect href={focus ? { pathname: '/assistant', params: { focus } } : '/assistant'} />;
}
