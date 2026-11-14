import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { LANGUAGES, type Language } from '@/i18n';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
import { ListRow } from './ui/Card';
import { CheckMark } from './ui/Check';
import { Sheet } from './ui/Sheet';

/**
 * Ф-50 «язык — с подтверждением»: both languages, each named in itself («Русский», «Қазақша»). Picking the other one
 * asks first, in both languages at once, so whoever tapped by mistake can read the question and say no.
 */
export function LanguageSheet({ visible, current, onClose, onPick }: { visible: boolean; current: Language; onClose: () => void; onPick: (l: Language) => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [asking, setAsking] = useState<Language | null>(null);
  const close = () => {
    setAsking(null);
    onClose();
  };
  return (
    <Sheet testID="lang-sheet" visible={visible} onClose={close} title={`${t('lang.choose')}`}>
      {asking ? (
        <View testID="lang-confirm" style={{ gap: theme.space[3] }}>
          <AppText variant="headline">{t(`lang.confirm_${asking}`)}</AppText>
          <AppText variant="callout">{t(`lang.confirm_${asking}_other`)}</AppText>
          <Button
            testID="lang-confirm-yes"
            label={t(`lang.switch_${asking}`)}
            onPress={() => {
              const l = asking;
              setAsking(null);
              onPick(l);
              onClose();
            }}
          />
          <Button testID="lang-confirm-no" label={t('lang.cancel')} variant="text" onPress={() => setAsking(null)} />
        </View>
      ) : (
        <View accessibilityRole="radiogroup">
          {LANGUAGES.map((l, i) => (
            <ListRow
              key={l}
              testID={`lang-${l}`}
              accessibilityRole="radio"
              selected={current === l}
              title={t(`lang.${l}`)}
              right={<CheckMark checked={current === l} />}
              separator={i < LANGUAGES.length - 1}
              onPress={() => (l === current ? close() : setAsking(l))}
            />
          ))}
        </View>
      )}
    </Sheet>
  );
}
