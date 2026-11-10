import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Checkbox } from '@/components/Checkbox';
import { DigitKeypad, NumberDisplay, pressDigit } from '@/components/kp/KpParts';
import { Screen } from '@/components/Screen';
import { StandaloneUndoStrip } from '@/components/UndoStrip';
import { priceText } from '@/kp/calc';
import { editKp } from '@/kp/service';
import { kpState, shownData, useKp } from '@/kp/store';
import { qtyShown } from '@/kp/view';
import { useTheme } from '@/theme';

/**
 * S28 «Ввести цены подряд» for one КП (2-design S28, 6.5): the lines with no price, one after
 * another — the name and the quantity big, the price on 64 pt keys, «Сохранить в прайс ☑» (on),
 * «Следующая ›». Each price is its own tap-edit with «Отменить», offline and in «Без ИИ» too; the
 * total is counted again by code. Voice («щит 18500, розетка 1200») needs the server: not here yet.
 */
export default function FastPricesScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { doc: docId } = useLocalSearchParams<{ doc: string }>();
  const doc = useKp((s) => s.docs[docId]);
  // The lines without a price when the screen opened: the count stays «2 из 5» while typing.
  const [todo] = useState<string[]>(() => {
    const data = shownData(docId, kpState());
    return data ? data.items.flatMap((it) => (it.unit_price === null ? [it.id] : [])) : [];
  });
  const [at, setAt] = useState(0);
  const [text, setText] = useState('');
  const [toList, setToList] = useState(true);
  const [bad, setBad] = useState(false);

  const done = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/kp/[id]', params: { id: docId } }));
  const data = useKp((s) => shownData(docId, s));
  const index = todo[at];
  const item = index !== undefined ? data?.items.find((x) => x.id === index) : undefined;

  const next = () => {
    if (!doc || index === undefined || !item) return;
    if (text !== '') {
      const value = priceText(text);
      if (value === null || value === '0.00') {
        setBad(true);
        return;
      }
      void editKp(doc.id, [{ item: index, field: 'unit_price', value }], { strip: t('kp.price_set', { name: item.name }), savePrices: toList });
    }
    setText('');
    setBad(false);
    setAt((n) => n + 1);
  };

  return (
    <View style={styles.root}>
      <Screen testID="kp-fast-screen">
        <View style={{ gap: theme.space[4] }}>
          <View style={styles.row}>
            <AppText testID="kp-fast-progress" variant="bodyStrong" accessibilityLiveRegion="polite" style={{ flex: 1 }}>
              {item ? t('kp.fast_progress', { n: at + 1, count: todo.length }) : t('kp.fast_all_done')}
            </AppText>
            <Button testID="kp-fast-done" label={t('kp.fast_done')} variant="text" minHeight={theme.size.minTouch} onPress={done} />
          </View>
          {item ? (
            <>
              <AppText testID="kp-fast-item" variant="title2" accessibilityRole="header">
                {t('kp.fast_item', { name: item.name, qty: qtyShown(item.qty), unit: item.unit ?? '' }).trim()}
              </AppText>
              <NumberDisplay testID="kp-fast-display" text={text} />
              {bad ? (
                <AppText testID="kp-fast-bad" color="warnText" accessibilityLiveRegion="polite">
                  {t('kp.edit_bad')}
                </AppText>
              ) : null}
              <Checkbox testID="kp-fast-to-list" label={t('kp.save_to_list')} checked={toList} onChange={setToList} />
              <DigitKeypad
                testID="kp-fast-keys"
                onKey={(k) => {
                  setBad(false);
                  setText((s) => pressDigit(s, k));
                }}
              />
              <Button testID="kp-fast-next" label={`${t('kp.next')} ›`} onPress={next} />
            </>
          ) : (
            <Button testID="kp-fast-back" label={t('kp.back')} onPress={done} />
          )}
        </View>
      </Screen>
      <StandaloneUndoStrip />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
