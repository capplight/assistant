import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckRow as Checkbox } from '../ui/Check';
import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import { Sheet } from '../page/ExpenseParts';
import { DigitKeypad, NumberDisplay, pressDigit } from './KpParts';

/**
 * A tap-edit of one number (S17): the price or the quantity of a line, typed on the big keys. No
 * model is involved. A price may also go to «Мой прайс» (`saveToList`, on by default when the list
 * has no such name yet).
 */
export function NumberSheet({
  title,
  initial,
  unit,
  money,
  offerList,
  onSave,
  onClose,
  testID = 'kp-number',
}: {
  title: string;
  initial: string;
  unit?: string | null;
  money: boolean;
  /** Show «Сохранить в прайс» (a price, not a quantity). */
  offerList?: boolean;
  onSave: (text: string, saveToList: boolean) => boolean;
  onClose: () => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial.replace('.', ','));
  const [toList, setToList] = useState(!!offerList);
  const [bad, setBad] = useState(false);
  return (
    <Sheet testID={testID} title={title} onClose={onClose}>
      <NumberDisplay testID={`${testID}-display`} text={text} unit={unit} money={money} />
      {bad ? (
        <AppText testID={`${testID}-bad`} color="warning" accessibilityLiveRegion="polite">
          {t('kp.edit_bad')}
        </AppText>
      ) : null}
      <DigitKeypad
        testID={`${testID}-keys`}
        onKey={(k) => {
          setBad(false);
          setText((s) => pressDigit(s, k, money ? 2 : 3));
        }}
      />
      {offerList ? <Checkbox testID={`${testID}-to-list`} label={t('kp.save_to_list')} checked={toList} onChange={setToList} /> : null}
      <Button
        testID={`${testID}-save`}
        label={t('kp.edit_save')}
        onPress={() => {
          if (!onSave(text, toList)) setBad(true);
        }}
      />
    </Sheet>
  );
}
