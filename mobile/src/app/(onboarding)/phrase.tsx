import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { Header } from '@/components/ui/Header';
import { PlaceTab, Row } from '@/components/ui/Leaf';
import { Screen } from '@/components/Screen';
import { suggestedPages } from '@/pages/premarks';
import { useAlarms } from '@/alarms/store';
import { getCapture } from '@/services';
import { introMarks, selectNoAi, useOnboarding } from '@/store/onboarding';
import { MAX_FONT_SCALE, useTheme, type PlaceKey } from '@/theme';

const PLACES: PlaceKey[] = ['notes', 'tasks', 'expenses'];

/**
 * S03 — first phrase (path 3). Typed here; the phrase becomes a local record + outbox item
 * (synced when online). TODO: voice on S03 (the assistant line already records voice).
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
    const capture = await getCapture();
    await capture.saveText({ text: phrase, source: 'typed', pageId: 'today' });
    // S35 ticks: the server's rule, run here (same vectors), so offline it is the same.
    const mark = suggestedPages(phrase, introMarks(interests)).join(',');
    const a = useAlarms.getState();
    if (a.caps?.notifications !== 'granted' && !a.notifyAskedAt) {
      router.push({ pathname: '/notify', params: { saved: phrase, next: 'gallery', mark } });
      return;
    }
    router.push({ pathname: '/gallery', params: { from: 'phrase', mark } });
  };

  return (
    // screens-v5 «Первая фраза»: the terracotta strip, the big question, examples as rows in the colour of their place.
    <Screen testID="phrase-screen" place="assistant" mode="strip">
      <Header title="" />
      <AppText accessibilityRole="header" style={[theme.type.title, { fontSize: 27, lineHeight: 32, letterSpacing: -0.5, marginTop: 10 }]}>
        {noAi ? t('phrase.title_typed') : t('phrase.title')}
      </AppText>
      <AppText variant="callout" style={{ fontSize: 16, marginTop: 8, marginBottom: 4 }}>
        {t('phrase.for_example')}
      </AppText>
      <View>
        {examples.map((ex, i) => (
          <Row key={i} first={i === 0} testID={`phrase-example-${i}`} accessibilityLabel={ex} onPress={() => submit(ex)}>
            <PlaceTab place={PLACES[i] ?? 'notes'} />
            <AppText numberOfLines={1} style={{ flex: 1 }}>
              {`«${ex}»`}
            </AppText>
          </Row>
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
            minHeight: theme.size.buttonHeight,
            borderWidth: 1.5,
            borderColor: theme.colors.ink,
            borderRadius: 26,
            paddingHorizontal: 18,
            color: theme.colors.ink,
            backgroundColor: theme.colors.paper,
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
