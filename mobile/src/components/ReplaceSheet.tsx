import { router } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import type { LocalRecord } from '@/db';
import { moveToPages } from '@/pages/manual';
import { visiblePages } from '@/pages/tabs';
import { usePageLabels } from '@/pages/usePageLabels';
import { useFeatures } from '@/store/features';
import { selectSortedPages, usePages, type Page } from '@/store/pages';
import { useView } from '@/store/view';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
import { ListGroup, ListRow } from './ui/Card';
import { Icon, PageIcon } from './ui/Icon';
import { Sheet } from './ui/Sheet';

/**
 * «Переложить «…»» (design-system v2 SaveToast → the sheet, Ф-50): the pages in tab order, the one it is on now marked
 * ✓ «сейчас здесь», «Расходы» says «станет тратой, спрошу сумму» (after the move the expense keypad opens there), and
 * «Запомню: такое кладу туда, куда выберете» — the server learns from the move (pages.md). One primary «Переложить».
 */
export function ReplaceSheet({ record, what, from, onClose }: { record: LocalRecord; what: string; from: Page | null; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { title } = usePageLabels();
  const shopping = useFeatures((f) => f.shopping);
  const pages = visiblePages(usePages(useShallow(selectSortedPages)), shopping);
  const [picked, setPicked] = useState<string | null>(null);
  const target = pages.find((p) => p.id === picked) ?? null;
  const go = () => {
    if (!target || !from || target.id === from.id) return onClose();
    onClose();
    void moveToPages(record, from, [target], 'move').then(() => {
      if (target.templateKey === 'expenses') {
        router.navigate({ pathname: '/page/[id]', params: { id: target.id } });
        useView.getState().requestKeypad();
      }
    });
  };
  return (
    // screens-v5-extra «Переложить»: the terracotta strip (opened from the assistant's result).
    <Sheet testID="replace-sheet" visible onClose={onClose} title={t('save.replace_title', { what })} place="assistant">
      <View style={{ gap: theme.space[3] }}>
        <AppText variant="callout">{t('save.replace_hint')}</AppText>
        <ListGroup>
          {pages.map((p) => {
            const here = from?.id === p.id;
            const on = picked ? picked === p.id : here;
            return (
              <ListRow
                key={p.id}
                testID={`replace-${p.id}`}
                accessibilityRole="radio"
                selected={on}
                left={
                  <View style={{ width: 34, height: 34, borderRadius: theme.radius.sm, backgroundColor: theme.colors.brandTint, alignItems: 'center', justifyContent: 'center' }}>
                    <PageIcon name={p.icon} color={theme.colors.brand} size={20} />
                  </View>
                }
                title={title(p)}
                meta={here ? t('save.here_now') : p.templateKey === 'expenses' ? t('save.becomes_expense') : undefined}
                right={
                  on ? (
                    <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: theme.colors.brand, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon icon={Check} size="sm" color="onBrand" />
                    </View>
                  ) : undefined
                }
                onPress={() => setPicked(p.id)}
              />
            );
          })}
        </ListGroup>
        <Button testID="replace-go" label={t('save.replace')} disabled={!target || target.id === from?.id} onPress={go} />
      </View>
    </Sheet>
  );
}
