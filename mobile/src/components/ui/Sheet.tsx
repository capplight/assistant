import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from './Button';
import { ListRow } from './Card';
import type { LucideIcon } from './Icon';
import { useReducedMotion } from './motion';

type SheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Pinned under the content (outside the scroll): the sheet's one main button. */
  footer?: ReactNode;
  /** A visible «Закрыть» next to the title (default on: closing must not depend on a swipe or the scrim). */
  closeButton?: boolean;
  /** Scrolls when taller than ~85 % of the window (default on). */
  scroll?: boolean;
  testID?: string;
};

/**
 * The one bottom sheet (design-system §3 Sheet): `surfaceRaised`, radius 24, a 36×4 handle, `scrim` that closes
 * on tap, ≤600 wide and centred on tablets, lifted above the keyboard on both platforms (edge-to-edge Android).
 * Reduced motion: fades instead of sliding.
 */
export function Sheet({ visible, onClose, title, children, footer, closeButton = true, scroll = true, testID }: SheetProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const body = (
    <View style={{ gap: theme.space[3] }}>
      {children}
    </View>
  );
  return (
    <Modal visible={visible} transparent animationType={reduced ? 'fade' : 'slide'} onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <View style={[styles.scrim, { backgroundColor: theme.colors.scrim, paddingTop: Math.round(height * 0.08) }]}>
          <Pressable
            testID={testID ? `${testID}-scrim` : undefined}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            importantForAccessibility="no"
            accessibilityElementsHidden
            onPress={onClose}
            style={StyleSheet.absoluteFill}
          />
          <SafeAreaView
            edges={['bottom']}
            testID={testID}
            style={[
              styles.sheet,
              {
                backgroundColor: theme.colors.surfaceRaised,
                borderTopLeftRadius: theme.radius.sheet,
                borderTopRightRadius: theme.radius.sheet,
                maxWidth: theme.size.maxContentWidth,
                paddingHorizontal: theme.space[5],
                paddingBottom: theme.space[4],
              },
              theme.elevation.floating,
            ]}
          >
            <View
              style={[
                styles.handle,
                {
                  width: theme.size.sheetHandle.width,
                  height: theme.size.sheetHandle.height,
                  backgroundColor: theme.colors.separator,
                  marginVertical: theme.space[2],
                },
              ]}
            />
            {title || closeButton ? (
              <View style={[styles.head, { gap: theme.space[2], marginBottom: theme.space[2] }]}>
                {title ? (
                  <AppText variant="headline" accessibilityRole="header" style={styles.flex}>
                    {title}
                  </AppText>
                ) : (
                  <View style={styles.flex} />
                )}
                {closeButton ? (
                  <Button testID={testID ? `${testID}-close` : undefined} label={t('common.close')} variant="text" onPress={onClose} />
                ) : null}
              </View>
            ) : null}
            {scroll ? (
              <ScrollView style={styles.shrink} keyboardShouldPersistTaps="handled">
                {body}
              </ScrollView>
            ) : (
              body
            )}
            {footer ? <View style={{ paddingTop: theme.space[3], gap: theme.space[2] }}>{footer}</View> : null}
          </SafeAreaView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export type SheetAction = {
  key: string;
  label: string;
  icon?: LucideIcon;
  onPress: () => void;
  /** Destructive: written in `danger`. */
  danger?: boolean;
  hint?: string;
  disabled?: boolean;
  testID?: string;
};

/** Actions of a sheet as rows, not a column of outline buttons (design-system §3 Sheet + ActionList). */
export function ActionList({ actions }: { actions: SheetAction[] }) {
  return (
    <View>
      {actions.map((a, i) => (
        <ListRow
          key={a.key}
          testID={a.testID}
          title={a.label}
          icon={a.icon}
          danger={a.danger}
          disabled={a.disabled}
          accessibilityHint={a.hint}
          onPress={a.onPress}
          separator={i < actions.length - 1}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexGrow: 0, flexShrink: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  // No maxHeight (it would cut text at 200 %): the scrim's top padding bounds it and the content scrolls.
  sheet: { width: '100%', flexShrink: 1 },
  handle: { alignSelf: 'center', borderRadius: 2 },
  head: { flexDirection: 'row', alignItems: 'center' },
});
