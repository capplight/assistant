import type { TextStyle } from 'react-native';

import type { AssistantEditOut } from '@/api/types';
import { wordDiff } from '@/records/diff';
import { useTheme } from '@/theme';

import { AppText, type AppTextProps } from './AppText';

/** The change of one field, or null when that field did not change (or the record moved on since). */
export function editOf(
  edit: AssistantEditOut | null | undefined,
  field: 'title' | 'text',
  now: string | null,
): { before: string; after: string } | null {
  const c = edit?.changes.find((x) => x.field === field);
  if (!c || c.after === null) return null;
  // The person changed it again since: the plain text, no stale diff.
  if (now !== null && now.trim() !== c.after.trim()) return null;
  return { before: c.before ?? '', after: c.after };
}

/**
 * design-system §11.8 «правка помощника прямо в тексте» (items.md «Inline edit»): the old words struck in `ink3`,
 * the new ones under the terracotta marker, the rest as it is.
 */
export function DiffText({
  before,
  after,
  testID,
  style,
  variant,
}: {
  before: string;
  after: string;
  testID?: string;
  style?: TextStyle;
  variant?: AppTextProps['variant'];
}) {
  const theme = useTheme();
  const parts = wordDiff(before, after);
  return (
    <AppText selectable testID={testID} variant={variant} style={style}>
      {parts.map((p, i) =>
        p.kind === 'same' ? (
          p.text
        ) : p.kind === 'del' ? (
          <AppText
            key={i}
            testID={testID ? `${testID}-del` : undefined}
            variant={variant}
            style={[
              style,
              { color: theme.colors.ink3, textDecorationLine: 'line-through', textDecorationColor: theme.colors.ink3 },
            ]}
          >
            {p.text}
          </AppText>
        ) : (
          <AppText
            key={i}
            testID={testID ? `${testID}-ins` : undefined}
            variant={variant}
            style={[style, { backgroundColor: theme.colors.marker }]}
          >
            {p.text}
          </AppText>
        ),
      )}
    </AppText>
  );
}
