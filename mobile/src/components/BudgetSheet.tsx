import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextInput, View } from 'react-native';

import { formatMinor, groupDigits, toMinor } from '@/expenses/calc';
import { setBudget } from '@/expenses/budget';
import { budgetMinor, useBudget } from '@/store/budget';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
import { Sheet } from './ui/Sheet';

/**
 * «Бюджет на месяц»: one amount in tenge, kept on this phone. With it «Расходы» and «Сегодня» say «осталось …»
 * and draw the budget bar; «Убрать» takes it away again.
 */
export function BudgetSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const current = useBudget(budgetMinor);
  const set = (m: bigint | null) => void setBudget(m);
  const [text, setText] = useState(current !== null ? groupDigits(String(current / 100n)) : '');
  const minor = toMinor(text.replace(/\s/g, ''));
  const save = () => {
    set(minor);
    onClose();
  };
  return (
    <Sheet testID="budget-sheet" visible={visible} onClose={onClose} title={t('budget.title')}>
      <View style={{ gap: theme.space[3] }}>
        <AppText variant="callout">{t('budget.hint')}</AppText>
        <TextInput
          testID="budget-input"
          accessibilityLabel={t('budget.title')}
          keyboardType="number-pad"
          value={text}
          onChangeText={(v) => setText(groupDigits(v.replace(/\D/g, '').replace(/^0+/, '')))}
          placeholder="120 000"
          placeholderTextColor={theme.colors.ink3}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            theme.type.title1,
            { color: theme.colors.ink, backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.md, paddingHorizontal: theme.space[4], minHeight: theme.size.buttonHeight + 6 },
          ]}
        />
        <Button testID="budget-save" label={minor && minor > 0n ? t('budget.save', { sum: formatMinor(minor) }) : t('budget.save_plain')} disabled={!minor || minor <= 0n} onPress={save} />
        {current !== null ? (
          <Button
            testID="budget-clear"
            label={t('budget.clear')}
            variant="text"
            onPress={() => {
              set(null);
              onClose();
            }}
          />
        ) : null}
      </View>
    </Sheet>
  );
}
