import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, TextInput, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { getOutbox } from '@/db';
import { premarksFromPhrase } from '@/pages/premarks';
import { selectNoAi, useOnboarding } from '@/store/onboarding';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

/**
 * S03 — first phrase (path 3). Week-1 stub: typed only; voice recording arrives in week 2
 * (expo-audio, no live transcription — R-17). The phrase is stored in the outbox; no backend yet.
 */
export default function PhraseScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const noAi = useOnboarding(selectNoAi);
  const interests = useOnboarding((s) => s.interests);
  const [text, setText] = useState('');

  const examples = [
    t('phrase.ex1'),
    interests.includes('money') ? t('phrase.ex_money') : t('phrase.ex2'),
    t('phrase.ex3'),
  ];

  const submit = async (value: string) => {
    const phrase = value.trim();
    if (!phrase) return;
    const outbox = await getOutbox();
    await outbox.enqueue('capture.text', { text: phrase, pageId: 'today', origin: 'onboarding_phrase' });
    router.push({ pathname: '/gallery', params: { from: 'phrase', mark: premarksFromPhrase(phrase).join(',') } });
  };

  return (
    <Screen testID="phrase-screen">
      <AppText variant="title1" accessibilityRole="header" style={{ marginBottom: theme.space[5] }}>
        {noAi ? t('phrase.title_typed') : t('phrase.title')}
      </AppText>
      <View style={{ gap: theme.space[3] }}>
        {examples.map((ex, i) => (
          <Pressable
            key={i}
            testID={`phrase-example-${i}`}
            accessibilityRole="button"
            onPress={() => submit(ex)}
            style={{
              minHeight: theme.size.primaryTouch,
              justifyContent: 'center',
              padding: theme.space[4],
              borderRadius: theme.radius.card,
              borderWidth: 1,
              borderColor: theme.colors.line,
              backgroundColor: theme.colors.surface,
            }}
          >
            <AppText>{ex}</AppText>
          </Pressable>
        ))}
      </View>
      <TextInput
        testID="phrase-input"
        accessibilityLabel={noAi ? t('phrase.title_typed') : t('phrase.title')}
        placeholder={t('line.placeholder')}
        placeholderTextColor={theme.colors.ink2}
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => submit(text)}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={[
          theme.type.body,
          {
            marginTop: theme.space[6],
            minHeight: theme.size.primaryTouch,
            borderWidth: 1,
            borderColor: theme.colors.lineStrong,
            borderRadius: theme.radius.input,
            paddingHorizontal: theme.space[3],
            color: theme.colors.ink,
            backgroundColor: theme.colors.surface,
          },
        ]}
      />
      <Button
        testID="phrase-send"
        label={t('phrase.send')}
        disabled={!text.trim()}
        onPress={() => submit(text)}
        style={{ marginTop: theme.space[3] }}
      />
    </Screen>
  );
}
