import { Check, ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { addDays, formatMinor } from '@/expenses/calc';
import { categoryTitle, MAX_CHIPS, type Category } from '@/expenses/categories';
import { display, evaluate, press, type Key } from '@/expenses/expression';
import { dayLabel } from '@/expenses/feed';
import { useTheme } from '@/theme';

import { AmountText } from '../AmountText';
import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import { ListGroup, ListRow } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { pressedStyle } from '../ui/motion';
import { Sheet as KitSheet } from '../ui/Sheet';
import { categoryLook } from './expenseColors';
import { ExpenseKeypad } from './ExpenseKeypad';

/** The sum as typed and what code made of it, for the board of the keys and the live region. */
export function useSum(initial = '') {
  const [text, setText] = useState(initial);
  const ev = evaluate(text);
  return { text, setText, ok: ev.ok, minor: ev.ok ? ev.minor : null, onKey: (k: Key) => setText((s) => press(s, k)) };
}

/** «1 200 + 350 ₸ / = 1 550 ₸», read aloud as the person types (live region polite). No box: the big sum itself. */
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
    <View testID={testID} accessible accessibilityLabel={label} accessibilityLiveRegion="polite" style={{ alignItems: 'center', paddingVertical: theme.space[2] }}>
      <AmountText
        testID={`${testID}-text`}
        variant="amount"
        maxScale={1.4}
        inset={theme.screenPadding * 2 + theme.space[5] * 2}
        color={text === '' ? 'ink2' : 'ink'}
        style={styles.center}
      >
        {`${shown} ₸`}
      </AmountText>
      {compound && total ? (
        <AppText testID={`${testID}-total`} variant="number" color="ink2" style={styles.center}>
          {`= ${total}`}
        </AppText>
      ) : null}
      {text !== '' && c === 'amount_not_positive' ? (
        <AppText testID={`${testID}-error`} color="warning" variant="callout">
          {t('exp.not_positive')}
        </AppText>
      ) : null}
      {c === 'amount_too_large' ? (
        <AppText testID={`${testID}-error`} color="warning" variant="callout">
          {t('exp.too_big')}
        </AppText>
      ) : null}
    </View>
  );
}

function spoken(text: string, t: (k: string) => string): string {
  return text.replace(/\+/g, ` ${t('exp.key_plus')} `).replace(/−/g, ` ${t('exp.key_minus')} `);
}

/** The category's icon in a 36 circle of its tint (icon, bar and segment share one colour). */
export function CategoryDot({ categoryKey, size = 36 }: { categoryKey: string | null; size?: number }) {
  const theme = useTheme();
  const look = categoryLook(theme, categoryKey);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: look.tint, alignItems: 'center', justifyContent: 'center' }}>
      <look.icon size={size >= 36 ? 20 : 16} color={look.color} strokeWidth={1.75} />
    </View>
  );
}

/**
 * The chips (8 and own ones) in the person's order: one scrolling row of 36 chips with the category's dot; the
 * picked one is filled `brand`. ≥150%: one column, so a long KK title never runs off. More than 10: «Ещё ›».
 */
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
  const column = theme.largeFont;
  const group = (
    <View
      testID={`${testID}-group`}
      accessibilityRole="radiogroup"
      accessibilityLabel={t('exp.categories')}
      style={{ flexDirection: column ? 'column' : 'row', gap: theme.space[2], alignItems: column ? 'stretch' : 'center' }}
    >
      {shown.map((c) => {
        const on = c.key === value;
        const look = categoryLook(theme, c.key);
        return (
          <Pressable
            key={c.key}
            testID={`${testID}-${c.key}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={categoryTitle(c, i18n.language)}
            onPress={() => onPick(c)}
            hitSlop={{ top: 6, bottom: 6 }}
            style={({ pressed }) => [
              styles.chip,
              {
                minHeight: column ? theme.size.minTouch : theme.size.buttonHeightSmall,
                paddingHorizontal: theme.space[3],
                gap: theme.space[2],
                borderRadius: theme.radius.round,
                backgroundColor: on ? theme.colors.brand : theme.colors.surfaceSunken,
              },
              pressedStyle(pressed),
            ]}
          >
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: on ? theme.colors.onBrand : look.color }} />
            <AppText variant="callout" color={on ? 'onBrand' : 'ink'} style={{ fontFamily: theme.type.sectionLabel.fontFamily, flexShrink: 1 }}>
              {categoryTitle(c, i18n.language)}
            </AppText>
          </Pressable>
        );
      })}
      {shown.length < categories.length ? (
        <Button testID={`${testID}-more`} label={t('exp.more_categories')} variant="text" size="small" onPress={() => setAll(true)} />
      ) : null}
    </View>
  );
  if (column) return group;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: 6 }}>
      {group}
    </ScrollView>
  );
}

/** «Сегодня ▾»: Сегодня / Вчера / another day with ‹ › (no future days), in one sheet of rows. */
export function DayChip({ value, today, onChange, testID = 'exp-day' }: { value: string; today: string; onChange: (d: string) => void; testID?: string }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = dayLabel(value, today, i18n.language, t);
  const yesterday = addDays(today, -1);
  const arrow = (step: -1 | 1) => {
    const off = step > 0 && value >= today;
    return (
      <Pressable
        testID={`${testID}-${step < 0 ? 'earlier' : 'later'}`}
        accessibilityRole="button"
        accessibilityLabel={t(step < 0 ? 'exp.day_earlier' : 'exp.day_later')}
        accessibilityState={step > 0 ? { disabled: off } : undefined}
        disabled={off}
        onPress={() => onChange(addDays(value, step))}
        style={({ pressed }) => [
          styles.square,
          { width: theme.size.minTouch, height: theme.size.minTouch, borderRadius: theme.size.minTouch / 2, backgroundColor: theme.colors.surfaceSunken, opacity: off ? 0.4 : 1 },
          pressedStyle(pressed),
        ]}
      >
        <Icon icon={step < 0 ? ChevronLeft : ChevronRight} color="ink" />
      </Pressable>
    );
  };
  return (
    <>
      <Button
        testID={testID}
        label={`${label} ▾`}
        accessibilityLabel={t('exp.day_a11y', { day: label })}
        variant="secondary"
        size="small"
        onPress={() => setOpen(true)}
        style={{ alignSelf: 'flex-start' }}
      />
      {open ? (
        <Sheet testID={`${testID}-sheet`} title={t('exp.day_pick')} onClose={() => setOpen(false)}>
          <ListGroup>
            <ListRow
              testID={`${testID}-today`}
              title={t('exp.day_today')}
              accessibilityRole="radio"
              selected={value === today}
              right={value === today ? <Icon icon={Check} color="brand" /> : undefined}
              onPress={() => {
                onChange(today);
                setOpen(false);
              }}
            />
            <ListRow
              testID={`${testID}-yesterday`}
              title={t('exp.day_yesterday')}
              accessibilityRole="radio"
              selected={value === yesterday}
              right={value === yesterday ? <Icon icon={Check} color="brand" /> : undefined}
              onPress={() => {
                onChange(yesterday);
                setOpen(false);
              }}
            />
          </ListGroup>
          <View style={[styles.row, { gap: theme.space[2], alignItems: 'center' }]}>
            {arrow(-1)}
            <AppText testID={`${testID}-value`} variant="headline" accessibilityLiveRegion="polite" style={[styles.flex, styles.center]}>
              {label}
            </AppText>
            {arrow(1)}
          </View>
          <Button testID={`${testID}-done`} label={t('common.ok')} onPress={() => setOpen(false)} />
        </Sheet>
      ) : null}
    </>
  );
}

/** The old call shape of the one kit sheet (`ui/Sheet`): open while mounted, a title and a test id. */
export function Sheet({
  title,
  onClose,
  children,
  testID,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  testID: string;
  footer?: React.ReactNode;
}) {
  return (
    <KitSheet visible testID={testID} title={title} onClose={onClose} footer={footer}>
      {children}
    </KitSheet>
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
  return (
    <View testID="exp-entry" style={{ gap: theme.space[3] }}>
      <SumDisplay text={sum.text} />
      {showCategories ? <CategoryChips categories={categories} value={category} onPick={onCategory} /> : null}
      {day && onDay ? <DayChip value={day} today={today} onChange={onDay} /> : null}
      <ExpenseKeypad onKey={sum.onKey} onSave={onSave} saveLabel={saveLabel} canSave={sum.ok} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  square: { alignItems: 'center', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center' },
});
