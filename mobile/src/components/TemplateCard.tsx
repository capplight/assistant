import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { TemplateKey } from '@/pages/templates';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { MiniSchema } from './MiniSchema';

type Props = {
  templateKey: TemplateKey;
  /** undefined → plain navigation card (S41); boolean → selectable card (S35). */
  checked?: boolean;
  title?: string;
  hint?: string;
  onPress: () => void;
  testID?: string;
  /** S35 «Добавить страницу»: a topic page the person has already («Уже есть ✓»), not pressable. */
  exists?: boolean;
};

/** Gallery card ~160×180: mini schema, title2, one-line benefit, 32 pt mark. Whole card is one target. */
export function TemplateCard({ templateKey, checked, title, hint, onPress, testID, exists = false }: Props) {
  const theme = useTheme();
  const { t } = useTranslation();
  const name = title ?? t(`tpl.${templateKey}`);
  const benefit = hint ?? t(`tpl.hint.${templateKey}`);
  const selectable = checked !== undefined;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={selectable ? 'checkbox' : 'button'}
      accessibilityState={selectable ? { checked: exists || checked, disabled: exists } : undefined}
      disabled={exists}
      accessibilityLabel={
        exists
          ? `${name}. ${t('gallery.exists')}. ${benefit}`
          : selectable
          ? t('gallery.card_a11y', {
              title: name,
              state: checked ? t('tour.selected') : t('tour.not_selected'),
              hint: benefit,
            })
          : `${name}. ${benefit}`
      }
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          minHeight: 180,
          padding: theme.space[4],
          borderRadius: theme.radius.card,
          backgroundColor: theme.colors.surface,
          borderColor: checked ? theme.colors.accent : theme.colors.line,
          borderWidth: checked ? 2 : 1,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={styles.top}>
        <View style={styles.flex}>
          <MiniSchema kind={templateKey} />
        </View>
        {selectable ? (
          <View
            style={[
              styles.mark,
              {
                borderColor: checked ? theme.colors.accent : theme.colors.lineStrong,
                backgroundColor: checked ? theme.colors.accent : 'transparent',
              },
            ]}
          >
            {checked ? (
              <AppText variant="bodyStrong" color="onAccent">
                ✓
              </AppText>
            ) : null}
          </View>
        ) : null}
      </View>
      <AppText variant="title2" style={{ marginTop: theme.space[2] }}>
        {name}
      </AppText>
      <AppText variant="meta">{benefit}</AppText>
      {exists ? (
        <AppText variant="meta" color="done" style={{ marginTop: theme.space[1] }}>
          {`${t('gallery.exists')} ✓`}
        </AppText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexGrow: 1, flexBasis: 150 },
  top: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
  mark: { width: 32, height: 32, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
