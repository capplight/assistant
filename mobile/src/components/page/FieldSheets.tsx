import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CustomFieldType } from '@/api/types';
import { CUSTOM_FIELD_TYPES } from '@/pages/catalog';
import type { FieldValue } from '@/pages/facets';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../ui/Button';

/** A bottom sheet with the app's look (paper surface, 20 pt radius). */
function Sheet({ testID, children, onClose }: { testID: string; children: ReactNode; onClose: () => void }) {
  const theme = useTheme();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID={testID}
          style={[
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.sheet,
              borderTopRightRadius: theme.radius.sheet,
              padding: theme.space[5],
              gap: theme.space[3],
            },
            theme.elevation.floating,
          ]}
        >
          {children}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Input({ testID, label, value, onChange, numeric, placeholder }: { testID: string; label: string; value: string; onChange: (v: string) => void; numeric?: boolean; placeholder?: string }) {
  const theme = useTheme();
  return (
    <TextInput
      testID={testID}
      accessibilityLabel={label}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.ink2}
      keyboardType={numeric ? 'decimal-pad' : 'default'}
      maxLength={60}
      autoFocus
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      style={[
        theme.type.body,
        {
          minHeight: theme.size.buttonHeight,
          borderWidth: 1,
          borderColor: theme.colors.iconSecondary,
          borderRadius: theme.radius.sm,
          paddingHorizontal: theme.space[3],
          color: theme.colors.ink,
          backgroundColor: theme.colors.bg,
        },
      ]}
    />
  );
}

/**
 * S38 «+ Своё поле» / the notebook's «+ Колонка» (2-design S38): a name and one of five types
 * (56 pt each), «Добавить» (accent). The limit of 5 is checked before the sheet opens.
 */
export function AddFieldSheet({ onAdd, onClose }: { onAdd: (title: string, type: CustomFieldType) => void; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  return (
    <Sheet testID="add-field-sheet" onClose={onClose}>
      <AppText variant="title2" accessibilityRole="header">
        {t('view.new_field')}
      </AppText>
      <AppText variant="callout">{t('view.field_name')}</AppText>
      <Input testID="add-field-name" label={t('view.field_name')} value={title} onChange={setTitle} placeholder={t('view.field_name_example')} />
      <AppText variant="callout">{t('view.field_type')}</AppText>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {CUSTOM_FIELD_TYPES.map((k) => (
          <Pressable
            key={k}
            testID={`add-field-type-${k}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: type === k }}
            onPress={() => setType(k)}
            style={{
              minHeight: theme.size.buttonHeight,
              minWidth: theme.largeFont ? '100%' : '30%',
              flexGrow: 1,
              borderWidth: type === k ? 2 : 1,
              borderColor: type === k ? theme.colors.brand : theme.colors.iconSecondary,
              borderRadius: theme.radius.md,
              paddingHorizontal: theme.space[3],
              justifyContent: 'center',
            }}
          >
            <AppText color={type === k ? 'brand' : 'ink'}>{`${type === k ? '● ' : '○ '}${t(`view.type.${k}`)}`}</AppText>
          </Pressable>
        ))}
      </View>
      <Button testID="add-field-add" label={t('view.add')} disabled={!title.trim()} onPress={() => onAdd(title.trim(), type)} />
      <Button testID="add-field-close" label={t('common.close')} variant="secondary" onPress={onClose} />
    </Sheet>
  );
}

/**
 * The notebook: a tap on a cell edits that one field in a sheet (larger and plainer than editing
 * in the cell, template-screens 2.6). «Галочка» is two big buttons.
 */
export function FieldValueSheet({
  title,
  type,
  value,
  onSave,
  onClose,
}: {
  title: string;
  type: CustomFieldType;
  value: FieldValue;
  onSave: (v: FieldValue) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  return (
    <Sheet testID="field-value-sheet" onClose={onClose}>
      <AppText variant="title2" accessibilityRole="header">
        {title}
      </AppText>
      {type === 'bool' ? (
        <View style={{ gap: theme.space[2] }}>
          <Button testID="field-value-yes" label={t('common.yes')} variant={value === true ? 'primary' : 'secondary'} onPress={() => onSave(true)} />
          <Button testID="field-value-no" label={t('view.no')} variant={value === false ? 'primary' : 'secondary'} onPress={() => onSave(false)} />
        </View>
      ) : (
        <>
          <Input
            testID="field-value-input"
            label={title}
            value={text}
            onChange={setText}
            numeric={type === 'number' || type === 'money'}
            placeholder={type === 'date' ? t('view.date_placeholder') : undefined}
          />
          <Button testID="field-value-save" label={t('page.name_save')} onPress={() => onSave(text.trim() ? text.trim() : null)} />
        </>
      )}
      <Button testID="field-value-close" label={t('common.close')} variant="secondary" onPress={onClose} />
    </Sheet>
  );
}

/** A choice among a few options (the notebook's «Вид ▾» at a large font, S38 sort / grouping). */
export function ChoiceSheet({
  testID,
  title,
  options,
  value,
  onPick,
  onClose,
}: {
  testID: string;
  title: string;
  options: { key: string; label: string }[];
  value: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Sheet testID={testID} onClose={onClose}>
      <AppText variant="title2" accessibilityRole="header">
        {title}
      </AppText>
      {options.map((o) => (
        <Pressable
          key={o.key}
          testID={`${testID}-${o.key}`}
          accessibilityRole="radio"
          accessibilityState={{ checked: o.key === value }}
          onPress={() => onPick(o.key)}
          style={{
            minHeight: theme.size.buttonHeight,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.separator,
            justifyContent: 'center',
          }}
        >
          <AppText color={o.key === value ? 'brand' : 'ink'}>{`${o.key === value ? '● ' : '○ '}${o.label}`}</AppText>
        </Pressable>
      ))}
      <Button testID={`${testID}-close`} label={t('common.close')} variant="secondary" onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
