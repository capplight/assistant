import { ChevronRight, Trash2 } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { onPlace, useTheme, type PlaceKey } from '@/theme';

import { AppText } from '../AppText';
import { Button } from './Button';
import { ButtonRow } from './Leaf';
import type { LucideIcon } from './Icon';
import { pressedStyle, useReducedMotion } from './motion';

/**
 * v5 floating and special surfaces (screens-v5.html): the compact confirmation of an irreversible action, the result
 * sheet in the chat and the white A4 page.
 */

/**
 * `.confirm` (design-system §11.9): ONLY for irreversible actions («Удалить навсегда», «Отправить клиенту», «Удалить
 * все данные»). A panel 10 from the edges at the bottom, radius 26, the screen under it stays visible (scrim .7);
 * the trash icon in a 40 `paper2` circle, the question 18 bold, one line why, «Не удалять» (outline) and the `danger`
 * button. Everything reversible goes without asking (Ф-75).
 */
export function CompactConfirm({
  visible,
  title,
  body,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  icon: Cmp = Trash2,
  danger = true,
  testID = 'compact-confirm',
}: {
  visible: boolean;
  title: string;
  body?: string;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  icon?: LucideIcon;
  /** «Отправить» is irreversible but not destructive: then the confirm button is the ordinary `btn`. */
  danger?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  return (
    <Modal visible={visible} transparent animationType={reduced ? 'fade' : 'slide'} onRequestClose={onCancel} statusBarTranslucent>
      <View style={styles.fill}>
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no"
          onPress={onCancel}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.scrim, opacity: 0.7 }]}
        />
        <View
          testID={testID}
          accessibilityViewIsModal
          style={[
            styles.panel,
            { backgroundColor: theme.colors.paper, marginBottom: 12 + insets.bottom, maxWidth: theme.size.maxContentWidth },
            { shadowColor: '#000000', shadowOffset: { width: 0, height: 18 }, shadowRadius: 40, shadowOpacity: 0.35, elevation: 16 },
          ]}
        >
          <View style={[styles.row, { alignItems: 'flex-start', gap: 12 }]}>
            <View style={[styles.circle, { backgroundColor: theme.colors.paper2 }]}>
              <Cmp size={22} color={danger ? theme.colors.danger : theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
            </View>
            <View style={styles.flex}>
              <AppText variant="headline" accessibilityRole="header" style={{ fontSize: 18, lineHeight: 23 }}>
                {title}
              </AppText>
              {body ? (
                <AppText variant="small" style={{ marginTop: 2 }}>
                  {body}
                </AppText>
              ) : null}
            </View>
          </View>
          <ButtonRow style={{ marginTop: 16 }}>
            <Button testID={`${testID}-cancel`} label={cancelLabel} variant="secondary" size="small" onPress={onCancel} />
            <Button testID={`${testID}-ok`} label={confirmLabel} variant={danger ? 'danger' : 'primary'} size="small" onPress={onConfirm} />
          </ButtonRow>
        </View>
      </View>
    </Modal>
  );
}

/**
 * `.res` (design-system §11.11 `ResultSheet`): what the assistant made, as a small sheet in the colour of its place —
 * «Дела · завтра, 10:00» over «Позвонить в ЦОН», a sum or a chevron on the right. Radius 18, text `onSheet`.
 */
export function ResultCard({
  place,
  icon: Cmp,
  caption,
  title,
  amount,
  onPress,
  testID,
  style,
  accessibilityLabel,
}: {
  place: PlaceKey;
  icon: LucideIcon;
  caption: string;
  title: string;
  amount?: string;
  onPress?: () => void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const on = onPlace(theme.colors, place);
  const body = (
    <>
      <Cmp size={22} color={on.ink} strokeWidth={theme.icon.strokeWidth} />
      <View style={styles.flex}>
        <AppText numberOfLines={1} style={{ color: on.ink2, fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 13, lineHeight: 16, marginBottom: 2 }}>
          {caption}
        </AppText>
        <AppText numberOfLines={1} style={{ color: on.ink, fontFamily: theme.type.headline.fontFamily, fontSize: 16, lineHeight: 20 }}>
          {title}
        </AppText>
      </View>
      {amount ? (
        <AppText style={[theme.type.number, { color: on.ink }]}>{amount}</AppText>
      ) : onPress ? (
        <ChevronRight size={18} color={on.ink} strokeWidth={theme.icon.strokeWidth} />
      ) : null}
    </>
  );
  const box: StyleProp<ViewStyle> = [styles.res, { backgroundColor: theme.colors.place[place] }, style];
  if (!onPress)
    return (
      <View testID={testID} style={box} accessibilityLabel={accessibilityLabel}>
        {body}
      </View>
    );
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? `${caption}. ${title}`} onPress={onPress} style={({ pressed }) => [box, pressedStyle(pressed)]}>
      {body}
    </Pressable>
  );
}

/**
 * `.a4`: a document page — white with `a4Ink` in BOTH themes (how it prints and goes to PDF), ratio 210 : 297,
 * radius 4, a soft shadow; lies on a `paper2` desk.
 */
export function A4Page({ children, testID, style }: { children: ReactNode; testID?: string; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.a4,
        { backgroundColor: theme.colors.a4 },
        { shadowColor: '#000000', shadowOffset: { width: 0, height: 10 }, shadowRadius: 30, shadowOpacity: 0.2, elevation: 6 },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  panel: { alignSelf: 'stretch', marginHorizontal: 10, borderRadius: 26, paddingTop: 18, paddingHorizontal: 18, paddingBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1, minWidth: 0 },
  circle: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  res: { borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  a4: { aspectRatio: 210 / 297, borderRadius: 4, paddingVertical: 22, paddingHorizontal: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.06)' },
});
