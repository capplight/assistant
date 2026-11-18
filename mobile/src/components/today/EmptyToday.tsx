import { ArrowUp, Check } from 'lucide-react-native';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { PlaceTab, Row, RowMeta, SectionHead } from '@/components/ui/Leaf';
import { onPlace, useTheme, type PlaceKey } from '@/theme';
import { withoutLastWord } from '@/today/empty';
import { useView } from '@/store/view';

/**
 * Ф-84 / Ф-85 (`today-day-view.html`, tokens `dayView`): the week on the yellow sheet. The chosen day is the dark
 * pill; today, when another day is chosen, has a 1.5 ring. Dots under the number: the day has something (up to 3).
 * A tap shows the day right here; a sideways swipe on the week goes to the week before / after.
 */
export type WeekDay = {
  date: string;
  label: string;
  num: string;
  name: string;
  count: number;
  past: boolean;
  today: boolean;
  selected?: boolean;
};

export function WeekStrip({
  days,
  onDay,
  onWeek,
}: {
  days: WeekDay[];
  onDay: (date: string) => void;
  onWeek?: (step: -1 | 1) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const c = onPlace(theme.colors, 'today');
  const bg = theme.colors.place.today;
  const small = theme.m.size === 'small';
  const anyChosen = days.some((d) => d.selected);
  const startX = useRef<number | null>(null);
  return (
    <View
      testID="today-week"
      nativeID="v5-week"
      accessibilityLabel={t('today.week')}
      accessibilityActions={
        onWeek
          ? [
              { name: 'decrement', label: t('today.week_prev') },
              { name: 'increment', label: t('today.week_next') },
            ]
          : undefined
      }
      onAccessibilityAction={onWeek ? (e) => onWeek(e.nativeEvent.actionName === 'decrement' ? -1 : 1) : undefined}
      onTouchStart={(e) => (startX.current = e.nativeEvent.pageX)}
      onTouchEnd={(e) => {
        const from = startX.current;
        startX.current = null;
        if (from === null || !onWeek) return;
        const dx = e.nativeEvent.pageX - from;
        if (Math.abs(dx) > 48) onWeek(dx < 0 ? 1 : -1);
      }}
      style={{ flexDirection: 'row', gap: 2, marginTop: small ? 10 : 14, marginHorizontal: small ? -4 : -6 }}
    >
      {days.map((d) => {
        const on = anyChosen ? !!d.selected : d.today;
        const ring = anyChosen && d.today && !d.selected;
        const dots = Math.min(3, d.count);
        const label =
          d.count > 0
            ? t('today.week_day', { day: d.name, count: d.count })
            : t('today.week_day_free', { day: d.name });
        return (
          <Pressable
            key={d.date}
            testID={`week-${d.date}`}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={label}
            accessibilityHint={t('today.week_hint')}
            onPress={() => onDay(d.date)}
            style={({ pressed }) => [
              {
                flex: 1,
                minWidth: 0,
                minHeight: 56,
                alignItems: 'center',
                gap: 4,
                paddingVertical: 7,
                borderRadius: 18,
              },
              on
                ? { backgroundColor: c.ink }
                : ring
                  ? { borderWidth: 1.5, borderColor: c.ink }
                  : pressed
                    ? { backgroundColor: 'rgba(0,0,0,0.06)' }
                    : null,
            ]}
          >
            <AppText
              numberOfLines={1}
              nativeID="v5-one-line"
              maxFontSizeMultiplier={1.5}
              style={{
                fontFamily: theme.type.sheetMeta.fontFamily,
                fontSize: 13,
                lineHeight: 15,
                color: on ? bg : c.ink2,
              }}
            >
              {d.label}
            </AppText>
            <AppText
              numberOfLines={1}
              nativeID="v5-one-line"
              maxFontSizeMultiplier={1.5}
              style={{
                fontFamily: d.past && !on ? theme.type.sheetMeta.fontFamily : theme.type.stripTitle.fontFamily,
                fontSize: small ? 17 : 18,
                lineHeight: small ? 19 : 20,
                fontVariant: ['tabular-nums'],
                color: on ? bg : d.past ? c.ink2 : c.ink,
              }}
            >
              {d.num}
            </AppText>
            <View testID={`week-dots-${d.date}`} style={{ flexDirection: 'row', gap: 3, height: 5 }}>
              {Array.from({ length: dots }, (_, i) => (
                <View key={i} style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: on ? bg : c.ink }} />
              ))}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

type Step = { key: 'note' | 'rem' | 'exp'; place: PlaceKey; done: boolean };

/**
 * «Три первые фразы» (option 1, first 7 days): a progress of three, three steps with an example phrase and the
 * place it goes to. A tap puts the phrase into the assistant strip without its last word; a step is ticked only
 * when such a record exists.
 */
export function FirstPhrases({ steps, first }: { steps: Step[]; first?: boolean }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const done = steps.filter((s) => s.done).length;
  return (
    <View testID="today-first">
      <SectionHead first={first} title={t('today.first_title')} right={t('today.first_progress', { done })} />
      <View
        style={{ flexDirection: 'row', gap: 4, marginTop: 2, marginBottom: 6 }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {steps.map((s) => (
          <View
            key={s.key}
            style={{
              flex: 1,
              height: 6,
              borderRadius: 3,
              backgroundColor: s.done ? theme.colors.ink : theme.colors.line,
            }}
          />
        ))}
      </View>
      {steps.map((s, i) => {
        const q = t(`today.first_${s.key}_q`);
        return (
          <Pressable
            key={s.key}
            testID={`first-${s.key}`}
            accessibilityRole="button"
            accessibilityState={{ checked: s.done }}
            accessibilityLabel={`${t(`today.first_${s.key}`)}. «${q}». ${t(`today.first_${s.key}_to`)}${s.done ? `. ${t('today.first_done')}` : ''}`}
            accessibilityHint={t('today.first_hint')}
            onPress={() => useView.getState().requestLine({ kind: 'text', text: withoutLastWord(q) })}
            style={({ pressed }) => [
              {
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 64,
                paddingVertical: 8,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: theme.colors.line,
              },
              pressed ? { backgroundColor: theme.colors.paper2 } : null,
            ]}
          >
            <View
              style={{
                width: 26,
                height: 26,
                borderRadius: 13,
                borderWidth: 2,
                borderColor: theme.colors.ink,
                backgroundColor: s.done ? theme.colors.ink : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {s.done ? <Check size={16} color={theme.colors.paper} strokeWidth={3} /> : null}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText
                numberOfLines={1}
                style={{ fontFamily: theme.type.bodyStrong.fontFamily, fontSize: 16, lineHeight: 20 }}
              >
                {t(`today.first_${s.key}`)}
              </AppText>
              <AppText numberOfLines={1} variant="small" style={{ color: theme.colors.ink2, marginTop: 2 }}>
                {`«${q}»`}
              </AppText>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                <PlaceTab place={s.place} style={{ width: 10, height: 14 }} />
                <AppText variant="footnote" numberOfLines={1}>
                  {t(`today.first_${s.key}_to`)}
                </AppText>
              </View>
            </View>
            <ArrowUp size={20} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** «Недавно сохранили · Заметки ›»: the last two notes, a notes tab, the title and when. */
export function RecentSaved({
  rows,
  onOpen,
  onAll,
}: {
  rows: { id: string; title: string; when: string }[];
  onOpen: (id: string) => void;
  onAll: () => void;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;
  return (
    <View testID="today-recent">
      <SectionHead
        title={t('today.recent')}
        link={t('today.recent_link')}
        onLink={onAll}
        linkTestID="today-recent-all"
      />
      {rows.map((r, i) => (
        <Row
          key={r.id}
          first={i === 0}
          testID={`recent-${r.id}`}
          onPress={() => onOpen(r.id)}
          accessibilityLabel={`${r.title}, ${r.when}`}
        >
          <PlaceTab place="notes" />
          <AppText numberOfLines={1} style={{ flex: 1 }}>
            {r.title}
          </AppText>
          <RowMeta>{r.when}</RowMeta>
        </Row>
      ))}
    </View>
  );
}
