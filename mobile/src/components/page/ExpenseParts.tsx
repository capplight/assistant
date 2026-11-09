import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { addDays, formatMinor } from '@/expenses/calc';
import { categoryTitle, MAX_CHIPS, type Category } from '@/expenses/categories';
import { display, evaluate, press, type Key } from '@/expenses/expression';
import { dayLabel } from '@/expenses/feed';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../Button';
import { ExpenseKeypad } from './ExpenseKeypad';

/** The sum as typed and what code made of it, for the board of the keys and the live region. */
export function useSum(initial = '') {
  const [text, setText] = useState(initial);
  const ev = evaluate(text);
  return { text, setText, ok: ev.ok, minor: ev.ok ? ev.minor : null, onKey: (k: Key) => setText((s) => press(s, k)) };
}

/** «1 200 + 350 ₸ / = 1 550 ₸», read aloud as the person types (live region polite). */
export function SumDisplay({ text, testID = 'exp-sum' }: { text: string; testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const ev = evaluate(text);
  const shown = text === '' ? '0' : display(text);
  const total = ev.ok ? formatMinor(ev.minor) : null;
  const compound = ev.ok && ev.terms > 1;
  const label =
    text === ''
      ? t('exp.sum_empty_a11y')
      : compound && total
        ? t('exp.sum_total_a11y', { text: spoken(text, t), amount: total })
        : t('exp.sum_a11y', { text: spoken(text, t) });
  const c = ev.ok ? 'ok' : ev.error;
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={{
        borderWidth: 1,
        borderColor: theme.colors.lineStrong,
        borderRadius: theme.radius.input,
        padding: theme.space[3],
        backgroundColor: theme.colors.bg,
        alignItems: 'flex-end',
      }}
    >
      <AppText testID={`${testID}-text`} variant="title1" maxFontSizeMultiplier={1.6} style={styles.right}>
        {`${shown} ₸`}
      </AppText>
      {compound && total ? (
        <AppText testID={`${testID}-total`} variant="number" style={styles.right}>
          {`= ${total}`}
        </AppText>
      ) : null}
      {text !== '' && c === 'amount_not_positive' ? (
        <AppText testID={`${testID}-error`} color="warnText" variant="meta">
          {t('exp.not_positive')}
        </AppText>
      ) : null}
      {c === 'amount_too_large' ? (
        <AppText testID={`${testID}-error`} color="warnText" variant="meta">
          {t('exp.too_big')}
        </AppText>
      ) : null}
    </View>
  );
}

function spoken(text: string, t: (k: string) => string): string {
  return text.replace(/\+/g, ` ${t('exp.key_plus')} `).replace(/−/g, ` ${t('exp.key_minus')} `);
}

/** The 8 chips (and own ones) in the person's order; ≥150%: one column; more than 10: «Ещё ›». */
export function CategoryChips({
  categories,
  value,
  onPick,
  testID = 'exp-cat',
}: {
  categories: Category[];
  value: string | null;
  onPick: (c: Category) => void;
  testID?: string;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all || categories.length <= MAX_CHIPS ? categories : categories.slice(0, MAX_CHIPS - 1);
  return (
    <View testID={`${testID}-group`} accessibilityRole="radiogroup" accessibilityLabel={t('exp.categories')} style={{ flexDirection: theme.largeFont ? 'column' : 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
      {shown.map((c) => {
        const on = c.key === value;
        return (
          <Pressable
            key={c.key}
            testID={`${testID}-${c.key}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={categoryTitle(c, i18n.language)}
            onPress={() => onPick(c)}
            style={{
              minHeight: theme.size.minTouch,
              justifyContent: 'center',
              paddingHorizontal: theme.space[3],
              borderRadius: theme.radius.chip,
              borderWidth: on ? 3 : 1,
              borderColor: on ? theme.colors.accent : theme.colors.lineStrong,
              backgroundColor: on ? theme.colors.surface : 'transparent',
            }}
          >
            <AppText variant={on ? 'bodyStrong' : 'body'} color={on ? 'accent' : 'ink'}>
              {categoryTitle(c, i18n.language)}
            </AppText>
          </Pressable>
        );
      })}
      {shown.length < categories.length ? (
        <Button testID={`${testID}-more`} label={t('exp.more_categories')} variant="text" minHeight={theme.size.minTouch} onPress={() => setAll(true)} />
      ) : null}
    </View>
  );
}

/** «Сегодня ▾»: Сегодня / Вчера / another day with ‹ › (no future days). */
export function DayChip({ value, today, onChange, testID = 'exp-day' }: { value: string; today: string; onChange: (d: string) => void; testID?: string }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = dayLabel(value, today, i18n.language, t);
  return (
    <>
      <Button
        testID={testID}
        label={`${label} ▾`}
        accessibilityLabel={t('exp.day_a11y', { day: label })}
        variant="outline"
        minHeight={theme.size.minTouch}
        onPress={() => setOpen(true)}
        style={{ alignSelf: 'flex-start' }}
      />
      {open ? (
        <Sheet testID={`${testID}-sheet`} title={t('exp.day_pick')} onClose={() => setOpen(false)}>
          <Button
            testID={`${testID}-today`}
            label={t('exp.day_today')}
            variant={value === today ? 'primary' : 'outline'}
            onPress={() => {
              onChange(today);
              setOpen(false);
            }}
          />
          <Button
            testID={`${testID}-yesterday`}
            label={t('exp.day_yesterday')}
            variant={value === addDays(today, -1) ? 'primary' : 'outline'}
            onPress={() => {
              onChange(addDays(today, -1));
              setOpen(false);
            }}
          />
          <View style={[styles.row, { gap: theme.space[2], alignItems: 'center' }]}>
            <Pressable
              testID={`${testID}-earlier`}
              accessibilityRole="button"
              accessibilityLabel={t('exp.day_earlier')}
              onPress={() => onChange(addDays(value, -1))}
              style={[styles.square, { width: theme.size.primaryTouch, height: theme.size.primaryTouch, borderColor: theme.colors.lineStrong, borderRadius: theme.radius.button }]}
            >
              <ChevronLeft size={28} color={theme.colors.ink} />
            </Pressable>
            <AppText testID={`${testID}-value`} variant="title2" accessibilityLiveRegion="polite" style={[styles.flex, styles.center]}>
              {label}
            </AppText>
            <Pressable
              testID={`${testID}-later`}
              accessibilityRole="button"
              accessibilityLabel={t('exp.day_later')}
              accessibilityState={{ disabled: value >= today }}
              disabled={value >= today}
              onPress={() => onChange(addDays(value, 1))}
              style={[
                styles.square,
                { width: theme.size.primaryTouch, height: theme.size.primaryTouch, borderColor: theme.colors.lineStrong, borderRadius: theme.radius.button, opacity: value >= today ? 0.45 : 1 },
              ]}
            >
              <ChevronRight size={28} color={theme.colors.ink} />
            </Pressable>
          </View>
          <Button testID={`${testID}-done`} label={t('common.ok')} onPress={() => setOpen(false)} />
        </Sheet>
      ) : null}
    </>
  );
}

/** A bottom sheet like «⋯ Ещё» (rows 56 pt, scrim, close button). */
export function Sheet({ title, onClose, children, testID }: { title: string; onClose: () => void; children: React.ReactNode; testID: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID={testID}
          style={[{ backgroundColor: theme.colors.surface, borderTopLeftRadius: theme.radius.sheet, borderTopRightRadius: theme.radius.sheet, maxHeight: '92%' }, theme.elevation?.sheet]}
        >
          <ScrollView contentContainerStyle={{ padding: theme.space[5], gap: theme.space[3] }}>
            <AppText variant="title2" accessibilityRole="header" numberOfLines={3}>
              {title}
            </AppText>
            {children}
            <Button testID={`${testID}-close`} label={t('common.close')} variant="text" onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/**
 * The keys with everything around them: «Набрать сумму», the sum, the day, the categories and the
 * 4×4 grid. «Записать» right after the sum and a chip: ≤3 taps after the amount (US-31).
 */
export function EntryPanel({
  sum,
  day,
  today,
  onDay,
  categories,
  category,
  onCategory,
  onSave,
  saveLabel,
  showCategories = true,
}: {
  sum: ReturnType<typeof useSum>;
  day?: string;
  today: string;
  onDay?: (d: string) => void;
  categories: Category[];
  category: string | null;
  onCategory: (c: Category) => void;
  onSave: () => void;
  saveLabel: string;
  showCategories?: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID="exp-entry" style={{ gap: theme.space[3] }}>
      <AppText variant="section" accessibilityRole="header">
        {t('exp.enter_hint')}
      </AppText>
      <SumDisplay text={sum.text} />
      {day && onDay ? <DayChip value={day} today={today} onChange={onDay} /> : null}
      {showCategories ? <CategoryChips categories={categories} value={category} onPick={onCategory} /> : null}
      <ExpenseKeypad onKey={sum.onKey} onSave={onSave} saveLabel={saveLabel} canSave={sum.ok} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  flex: { flex: 1 },
  right: { textAlign: 'right' },
  center: { textAlign: 'center' },
  square: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
