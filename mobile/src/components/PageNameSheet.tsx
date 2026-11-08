import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MAX_FONT_SCALE, useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

/** The server takes names of 1-60 chars. */
const MAX_NAME = 60;

/**
 * «Как назвать?» (2-design 4.5.3): for a new «Своя страница» and for renaming one. «Пока без
 * названия» gives «Моя страница». Rendered only while open, so the field starts fresh every time.
 */
export function PageNameSheet({
  initial = '',
  onSave,
  onClose,
  title,
}: {
  initial?: string;
  onSave: (name: string) => void;
  onClose: () => void;
  /** Another question than «Как назвать?» (a stack); then there is no «Пока без названия». */
  title?: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}
      >
        <SafeAreaView
          edges={['bottom']}
          testID="page-name-sheet"
          style={[
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.sheet,
              borderTopRightRadius: theme.radius.sheet,
              padding: theme.space[5],
              gap: theme.space[3],
            },
            theme.elevation?.sheet,
          ]}
        >
          <AppText variant="title2" accessibilityRole="header">
            {title ?? t('page.name_title')}
          </AppText>
          <TextInput
            testID="page-name-input"
            accessibilityLabel={title ?? t('page.name_title')}
            placeholder={t('page.name_placeholder')}
            placeholderTextColor={theme.colors.ink2}
            value={name}
            onChangeText={setName}
            maxLength={MAX_NAME}
            autoFocus
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            onSubmitEditing={() => onSave(name)}
            style={[
              theme.type.body,
              {
                minHeight: theme.size.primaryTouch,
                borderWidth: 1,
                borderColor: theme.colors.lineStrong,
                borderRadius: theme.radius.input,
                paddingHorizontal: theme.space[3],
                color: theme.colors.ink,
                backgroundColor: theme.colors.bg,
              },
            ]}
          />
          <Button testID="page-name-save" label={t('page.name_save')} onPress={() => onSave(name)} />
          {title ? null : (
            <Button testID="page-name-later" label={t('page.name_later')} variant="text" onPress={() => onSave('')} />
          )}
          <Button testID="page-name-close" label={t('common.close')} variant="outline" onPress={onClose} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
