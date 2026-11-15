import { CalendarClock, ListChecks, NotebookPen, ReceiptText, ShoppingCart, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

import { useLayout, useTheme } from '@/theme';

import { Chip } from './ui/Chip';

type Hint = { key: string; icon: LucideIcon; label: string; phrase: string };

/**
 * The line's suggestion chips (design-system v2 AssistantCapsule «подсказки»): 2–3 chips above the capsule while the
 * field is empty and focused, by screen. A tap puts the start of the phrase in the field — the person finishes and
 * sends it; nothing is sent by the chip.
 */
export function LineChips({ kind, onPick }: { kind: string; onPick: (phrase: string) => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { width } = useLayout();
  const note: Hint = { key: 'note', icon: NotebookPen, label: t('line.chip_note'), phrase: t('line.chip_note_phrase') };
  const tomorrow: Hint = { key: 'tomorrow', icon: CalendarClock, label: t('line.chip_tomorrow'), phrase: t('line.chip_tomorrow') };
  const remind: Hint = { key: 'remind', icon: ListChecks, label: t('line.chip_remind'), phrase: t('line.chip_remind_phrase') };
  const buy: Hint = { key: 'buy', icon: ShoppingCart, label: t('line.chip_buy'), phrase: t('line.chip_buy_phrase') };
  const spend: Hint = { key: 'spend', icon: ReceiptText, label: t('line.chip_spend'), phrase: t('line.chip_spend_phrase') };
  const all: Hint[] =
    kind === 'tasks' ? [tomorrow, remind, buy] : kind === 'expenses' ? [spend, tomorrow] : kind === 'notes' ? [note, remind] : [note, tomorrow, remind];
  // QA v2 §4.8: under 400 dp two chips, so the last one is never cut mid-word.
  const hints = width < 400 ? all.slice(0, 2) : all;
  return (
    <ScrollView
      testID="line-chips"
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      contentContainerStyle={{ gap: theme.space[2], paddingHorizontal: theme.size.tabBarInset, paddingBottom: theme.space[2] }}
    >
      {hints.map((h) => (
        <Chip key={h.key} testID={`line-chip-${h.key}`} label={h.label} icon={h.icon} variant="neutral" onPress={() => onPick(h.phrase)} />
      ))}
    </ScrollView>
  );
}
