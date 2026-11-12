import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput } from 'react-native';

import { MAX_FONT_SCALE, useTheme } from '@/theme';

import { Button } from './ui/Button';
import { Sheet } from './ui/Sheet';

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
    <Sheet visible onClose={onClose} title={title ?? t('page.name_title')} testID="page-name-sheet" closeButton={false} scroll={false}>
      <TextInput
        testID="page-name-input"
        accessibilityLabel={title ?? t('page.name_title')}
        placeholder={t('page.name_placeholder')}
        placeholderTextColor={theme.colors.ink3}
        value={name}
        onChangeText={setName}
        maxLength={MAX_NAME}
        autoFocus
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        onSubmitEditing={() => onSave(name)}
        style={[
          theme.type.body,
          {
            minHeight: theme.size.buttonHeight,
            borderRadius: theme.radius.sm,
            paddingHorizontal: theme.space[3],
            color: theme.colors.ink,
            backgroundColor: theme.colors.surfaceSunken,
          },
        ]}
      />
      <Button testID="page-name-save" label={t('page.name_save')} onPress={() => onSave(name)} />
      {title ? null : <Button testID="page-name-later" label={t('page.name_later')} variant="text" onPress={() => onSave('')} />}
      <Button testID="page-name-close" label={t('common.close')} variant="secondary" onPress={onClose} />
    </Sheet>
  );
}
