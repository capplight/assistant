import { StyleSheet, View } from 'react-native';

import type { TemplateKey } from '@/pages/templates';
import { useTheme } from '@/theme';

import { AppText } from './AppText';

/**
 * Abstract page preview for gallery cards: lines and plates in `line` colour, no real data,
 * no people or photos (2-design §4.5.2). Decorative — hidden from screen readers.
 */
export function MiniSchema({ kind }: { kind: TemplateKey }) {
  const theme = useTheme();
  const bar = (w: number | `${number}%`) => (
    <View style={{ height: 8, width: w, borderRadius: 4, backgroundColor: theme.colors.line, marginBottom: 6 }} />
  );
  const box = (checked: boolean, key: number) => (
    <View
      key={key}
      style={{
        width: 16,
        height: 16,
        borderRadius: 3,
        borderWidth: 2,
        borderColor: theme.colors.lineStrong,
        backgroundColor: checked ? theme.colors.lineStrong : 'transparent',
        marginRight: 6,
      }}
    />
  );
  let content;
  switch (kind) {
    case 'custom':
      content = (
        <View style={[styles.dashed, { borderColor: theme.colors.lineStrong, borderRadius: theme.radius.input }]}>
          <AppText variant="title2" color="ink2">
            +
          </AppText>
        </View>
      );
      break;
    case 'tasks':
    case 'shopping':
      content = (
        <View>
          <View style={styles.row}>{[true, false, false].map(box)}</View>
          {bar('80%')}
          {bar('60%')}
        </View>
      );
      break;
    case 'expenses':
      content = (
        <View>
          <AppText variant="number" color="ink2">
            214 600 ₸
          </AppText>
          {bar('70%')}
          {bar('40%')}
        </View>
      );
      break;
    default:
      content = (
        <View>
          {bar('90%')}
          {bar('75%')}
          {bar('55%')}
        </View>
      );
  }
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.wrap}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 56, justifyContent: 'center' },
  row: { flexDirection: 'row', marginBottom: 8 },
  dashed: {
    borderWidth: 2,
    borderStyle: 'dashed',
    width: 56,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
