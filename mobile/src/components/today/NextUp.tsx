import { ChevronRight } from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { hmShort } from '@/calendar/time';
import { AppText } from '@/components/AppText';
import { durText } from '@/components/calendar/parts';
import { pressedStyle, useReducedMotion } from '@/components/ui/motion';
import { nextUp, reducedMotionFade, todayMotion, useTheme } from '@/theme';
import { nextUpHeight, type NextUpState } from '@/today/v6';

type T = (k: string, o?: Record<string, unknown>) => string;

/** «через 1 ч 40 мин» · «через 50 мин» · «сейчас» (§3.2). */
export function inText(t: T, minutes: number): string {
  return minutes <= 0 ? t('cal.now_word') : t('cal.in', { time: durText(t, minutes) });
}

/** «50 минут», «1 час 40 минут» for the screen reader. */
function longDur(t: T, minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return t('today6.a11y_min', { count: r });
  if (r === 0) return t('today6.a11y_h', { count: h });
  return t('today6.a11y_hm', { h: t('today6.a11y_h', { count: h }), m: t('today6.a11y_min', { count: r }) });
}

/** The two lines and the screen-reader label of the card. Pure (the words only), for tests. */
export function nextUpText(s: NextUpState, t: T, weekdayDay: (date: string) => string): { l1: string; l2: string; label: string } {
  if (s.kind === 'none' || !s.entry) return { l1: t('today6.next_none'), l2: t('today6.next_open'), label: t('today6.a11y_next_none') };
  const e = s.entry;
  const time = e.start !== null ? hmShort(e.start) : '';
  const l2 = `${time} ${e.title}`.trim();
  const m = s.minutes ?? 0;
  switch (s.kind) {
    case 'now':
      return {
        l1: t('today6.next_now', { left: durText(t, m) }),
        l2,
        label: t('today6.a11y_next', { head: t('today6.head_now'), time, title: e.title, when: t('today6.a11y_left', { time: longDur(t, m) }) }),
      };
    case 'first':
    case 'next': {
      const head = s.kind === 'first' ? t('today6.head_first') : t('today6.head_next');
      const when = m <= 0 ? t('cal.now_word') : t('today6.a11y_in', { time: longDur(t, m) });
      return {
        l1: s.kind === 'first' ? t('today6.next_first', { in: inText(t, m) }) : t('today6.next', { in: inText(t, m) }),
        l2,
        label: t('today6.a11y_next', { head, time, title: e.title, when }),
      };
    }
    case 'tomorrow':
      return { l1: t('today6.next_tomorrow'), l2, label: t('today6.a11y_next_plain', { head: t('today6.next_tomorrow'), time, title: e.title }) };
    default: {
      const day = weekdayDay(s.date);
      return {
        l1: t('today6.next_nearest', { day }),
        l2,
        label: t('today6.a11y_next_plain', { head: t('today6.head_nearest', { day }), time, title: e.title }),
      };
    }
  }
}

/**
 * today-v6-acceptance.md §3.2 — «Дальше» (option A) on the yellow sheet: a white card of a fixed height (64, 88 with
 * large text), the calendar leaf (day of the week on an `ink` band, the number), two one-line rows and «›» (with the
 * word «Календарь» from 400 dp). The whole card opens the calendar «День» on the leaf's date. A new state (the next
 * thing starts or ends) fades in over 180 ms; the height never changes.
 */
export function NextUp({
  state,
  onPress,
  testID = 'today-next',
}: {
  state: NextUpState;
  onPress: (date: string) => void;
  testID?: string;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const reduced = useReducedMotion();
  const c = theme.colors;
  const m = theme.m;
  const large = m.largeText;
  const fmt = (date: string, o: Intl.DateTimeFormatOptions) => {
    try {
      return new Date(`${date}T12:00:00`).toLocaleDateString(i18n.language, o);
    } catch {
      return date;
    }
  };
  const dayOf = (d: string) => new Date(`${d}T12:00:00`).getDate();
  const text = nextUpText(state, t, (d) => `${fmt(d, { weekday: 'long' })}, ${dayOf(d)}`);
  const head = fmt(state.date, { weekday: 'short' }).replace(/\.$/u, '').toUpperCase();
  const num = String(dayOf(state.date));
  const word = m.width >= nextUp.wordFrom;
  // The card's text never outgrows its fixed height: ×1.1 normally, ×1.2 (and 2 lines for the title) with large text.
  const cap = large ? 1.2 : 1.1;
  // Line 2 «15:00 Стоматолог»: the time never cut (its own text), the title one line with «…» (2 with large text).
  const time = state.kind !== 'none' && state.entry?.start != null ? hmShort(state.entry.start) : '';
  const title = state.kind === 'none' || !state.entry ? text.l2 : state.entry.title;
  const l2Style = { fontFamily: theme.type.section.fontFamily, fontSize: nextUp.l2, lineHeight: large ? 20 : 22, color: c.ink, fontVariant: ['tabular-nums' as const] };

  // §3.2: the next state fades in (180 ms, UI thread); the first frame is already final.
  const fade = useSharedValue(1);
  const key = `${state.kind}|${state.entry?.key ?? ''}|${state.date}`;
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    fade.set(0);
    fade.set(withTiming(1, { duration: reduced ? reducedMotionFade : todayMotion.periodFade }));
  }, [key, fade, reduced]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={text.label}
      onPress={() => onPress(state.date)}
      style={({ pressed }) => [
        {
          marginTop: nextUp.gap,
          minHeight: nextUpHeight(m),
          borderRadius: nextUp.radius,
          backgroundColor: c.paper,
          paddingVertical: nextUp.pad.v,
          paddingHorizontal: nextUp.pad.h,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
        },
        pressedStyle(pressed, reduced),
      ]}
    >
      <View
        testID={`${testID}-leaf`}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: nextUp.leaf.w,
          height: nextUp.leaf.h,
          borderRadius: nextUp.leaf.radius,
          borderWidth: nextUp.leaf.border,
          borderColor: c.ink,
          backgroundColor: c.paper,
          overflow: 'hidden',
          alignItems: 'center',
        }}
      >
        <View style={{ alignSelf: 'stretch', height: nextUp.leaf.head - nextUp.leaf.border, backgroundColor: c.ink, justifyContent: 'center' }}>
          <AppText
            testID={`${testID}-leaf-day`}
            maxFontSizeMultiplier={1}
            numberOfLines={1}
            style={{ fontFamily: theme.type.title.fontFamily, fontSize: 10, lineHeight: 12, color: c.paper, textAlign: 'center' }}
          >
            {head}
          </AppText>
        </View>
        <AppText
          testID={`${testID}-leaf-num`}
          maxFontSizeMultiplier={1}
          numberOfLines={1}
          style={{ fontFamily: theme.type.title.fontFamily, fontSize: nextUp.leaf.num, lineHeight: 28, color: c.ink, fontVariant: ['tabular-nums'] }}
        >
          {num}
        </AppText>
      </View>
      <Animated.View style={[{ flex: 1, minWidth: 0 }, fadeStyle]}>
        <AppText
          testID={`${testID}-l1`}
          nativeID="v5-capped"
          numberOfLines={1}
          maxFontSizeMultiplier={cap}
          style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: nextUp.l1, lineHeight: large ? 16 : 17, color: c.ink2, fontVariant: ['tabular-nums'] }}
        >
          {text.l1}
        </AppText>
        <View testID={`${testID}-l2`} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 5 }}>
          {time ? (
            <AppText nativeID="v5-capped" maxFontSizeMultiplier={cap} style={l2Style}>
              {time}
            </AppText>
          ) : null}
          <AppText nativeID="v5-capped" numberOfLines={large ? 2 : 1} maxFontSizeMultiplier={cap} style={[l2Style, { flex: 1, minWidth: 0 }]}>
            {title}
          </AppText>
        </View>
      </Animated.View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
        {word ? (
          <AppText
            testID={`${testID}-word`}
            nativeID="v5-capped"
            numberOfLines={1}
            maxFontSizeMultiplier={cap}
            style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 13, lineHeight: 16, color: c.ink2 }}
          >
            {t('today6.calendar')}
          </AppText>
        ) : null}
        <ChevronRight size={18} color={c.ink2} strokeWidth={theme.icon.strokeWidth} />
      </View>
    </Pressable>
  );
}
