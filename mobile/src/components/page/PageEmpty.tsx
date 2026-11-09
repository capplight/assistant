import { View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';

/** An empty page: what will be here and one or more examples to say (2-design 4.5.3). */
export function PageEmpty({ lines, title }: { lines: string[]; title?: string }) {
  const theme = useTheme();
  const [first, ...rest] = lines;
  return (
    <View
      testID="page-empty"
      style={{
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.line,
        borderWidth: 1,
        borderRadius: theme.radius.card,
        padding: theme.space[4],
        gap: theme.space[2],
      }}
    >
      {title ? (
        <AppText variant="title2" accessibilityRole="header">
          {title}
        </AppText>
      ) : null}
      {first ? <AppText>{first}</AppText> : null}
      {rest.map((l) => (
        <AppText key={l} variant="meta">
          {l}
        </AppText>
      ))}
    </View>
  );
}
