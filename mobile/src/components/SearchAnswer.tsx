import { Copy, ExternalLink } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Share, StyleSheet, View } from 'react-native';

import type { ChatMessage } from '@/store/assistant';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { StatusDot } from './ui/Brief';
import { cardEdge } from './ui/Card';
import { Chip } from './ui/Chip';
import { useSourceLabel } from './SourceChips';

/**
 * A short answer is a value: «4512», «Код домофона — 4512.», «Подъезд 3, кв. 47: 4512». Returns the value and the
 * rest as its note, or null when the answer is a sentence to read (then it stays text).
 */
export function directValue(text: string): { value: string; note: string | null } | null {
  const s = text.trim().replace(/[.。]$/, '');
  if (!s || s.includes('\n') || s.length > 90) return null;
  const parts = /^(.{2,60}?)\s*(?:—|–|-|:)\s*(.{1,24})$/u.exec(s);
  if (parts && /\d/.test(parts[2]!) && parts[2]!.split(/\s+/).length <= 4) return { value: parts[2]!.trim(), note: parts[1]!.trim() };
  if (s.length <= 24 && s.split(/\s+/).length <= 4) return { value: s, note: null };
  return null;
}

/**
 * SearchAnswer (design-system v2 §5): a card — glowing dot + «ОТВЕТ», the value in `answerValue`, its note, chips
 * «Скопировать» and «Открыть», and «Источник: «Заметки» · 2 марта». A long answer stays text in the same card.
 */
export function SearchAnswer({ answer, onOpen }: { answer: ChatMessage; onOpen?: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const label = useSourceLabel();
  const showToast = useToast((s) => s.show);
  const v = answer.value ? { value: answer.value, note: answer.text.trim() !== answer.value ? answer.text : null } : directValue(answer.text);
  const source = answer.sources?.[0];
  const copy = () => {
    // No clipboard module in the app: the system share sheet has «Копировать» on both platforms.
    void Share.share({ message: v?.value ?? answer.text }).catch(() => undefined);
    showToast(t('search.copied'), 2500);
  };
  return (
    <View testID="search-answer" style={[{ backgroundColor: theme.colors.surface, borderRadius: theme.radius.xxl, padding: theme.space[4] + 2, gap: theme.space[2] }, theme.elevation.card, cardEdge(theme)]}>
      <View style={[styles.row, { gap: theme.space[2] }]}>
        <StatusDot />
        <AppText variant="eyebrow" color="brand">
          {t('search.answer')}
        </AppText>
      </View>
      {v ? (
        <>
          <AppText testID="search-answer-value" variant="answerValue" accessibilityRole="header">
            {v.value}
          </AppText>
          {v.note ? <AppText color="ink2">{v.note}</AppText> : null}
        </>
      ) : (
        <AppText testID="search-answer-text">{answer.text}</AppText>
      )}
      <View style={[styles.row, { gap: theme.space[2], flexWrap: 'wrap' }]}>
        <Chip testID="search-answer-copy" label={t('search.copy')} icon={Copy} onPress={copy} />
        {onOpen ? <Chip testID="search-answer-open" label={t('search.open')} icon={ExternalLink} onPress={onOpen} /> : null}
      </View>
      {source ? (
        <AppText testID="search-answer-source" variant="footnote">
          {t('search.source', { source: label(source).label })}
        </AppText>
      ) : null}
      {answer.aiGenerated ? (
        <AppText testID="search-answer-ai" variant="footnote">
          {t('ai.label_short')}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
