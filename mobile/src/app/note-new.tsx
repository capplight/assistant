import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button } from '@/components/ui/Button';
import { Header } from '@/components/ui/Header';
import { usePageLabels } from '@/pages/usePageLabels';
import { getCapture } from '@/services';
import { usePages } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { MAX_FONT_SCALE, placeOfTemplate, useTheme } from '@/theme';

/**
 * «Новая заметка» (add-entry-model.md §5, QA D1): the page «+» of «Заметки» and of an own page. One big field with
 * the focus at once and «Сохранить». It is a local record (`capture.saveText`), so it works offline and in «Без ИИ»;
 * empty text is not saved. Back, then «Сохранил · Отменить».
 */
export default function NoteNewScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { title } = usePageLabels();
  const params = useLocalSearchParams<{ page?: string }>();
  const page = usePages((s) => s.pages.find((p) => p.id === params.page));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const own = !!page && page.templateKey !== 'notes';
  const place = page ? placeOfTemplate(page.templateKey) : 'notes';

  const close = () => {
    if (router.canGoBack()) router.back();
    else if (page) router.replace({ pathname: '/page/[id]', params: { id: page.id } });
    else router.replace('/');
  };
  const save = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const rec = await (await getCapture()).saveText({ text: value, source: 'typed', pageId: page?.id });
      const notes = usePages.getState().pages.find((p) => p.templateKey === 'notes') ?? null;
      useUndo.getState().showSaved(rec.id, page?.id ?? notes?.id ?? null, (value.split(/\r?\n/)[0] ?? '').slice(0, 60));
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      testID="note-new-screen"
      place={place}
      mode="strip"
      footer={
        <Button
          testID="note-new-save"
          label={t('add.save')}
          disabled={text.trim().length === 0 || busy}
          onPress={() => void save()}
        />
      }
    >
      <Header
        title={own ? t('add.record_new') : t('add.note_new')}
        back={{ onPress: close, label: page ? title(page) : t('common.close'), testID: 'note-new-close' }}
      />
      <TextInput
        testID="note-new-text"
        accessibilityLabel={own ? t('add.record_new') : t('add.note_new')}
        placeholder={t('add.note_placeholder')}
        placeholderTextColor={theme.colors.ink2}
        value={text}
        onChangeText={setText}
        autoFocus
        multiline
        textAlignVertical="top"
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={[
          theme.type.noteBody,
          {
            minHeight: 220,
            borderRadius: 16,
            borderWidth: 1.5,
            borderColor: theme.colors.ink,
            padding: theme.space[4],
            color: theme.colors.ink,
            backgroundColor: theme.colors.paper,
          },
        ]}
      />
    </Screen>
  );
}
