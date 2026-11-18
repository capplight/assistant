import { ChevronLeft, Plus } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, Easing, Pressable, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { PlaceTab, Row, RowMeta, SectionHead } from '@/components/ui/Leaf';
import { plan as planGeometry, stickerColors, useTheme, type PlaceKey } from '@/theme';

/**
 * QA v5-device-2 A8 (Ф-85, `today-day-view.html`, tokens `dayView`): a day of the week shown in place on «Сегодня» —
 * the sheet and the week stay, the paper shows that day. «К сегодня» stands where the search icon was.
 */

/** «‹ К сегодня» — a 36 capsule on the paper colour, in the sheet's top row. */
export function BackToToday({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Pressable
      testID="today-back"
      accessibilityRole="button"
      accessibilityLabel={t('today.dv_back_a11y')}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        minHeight: 36,
        borderRadius: 18,
        paddingLeft: 8,
        paddingRight: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        backgroundColor: theme.colors.paper,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <ChevronLeft size={18} color={theme.colors.ink} strokeWidth={2.2} />
      <AppText
        numberOfLines={1}
        nativeID="v5-one-line"
        style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 15, lineHeight: 18, color: theme.colors.ink }}
      >
        {t('today.dv_back')}
      </AppText>
    </Pressable>
  );
}

/** The content of a day changes with a 180 ms fade and an 8 dp slide toward the tapped day (`motion.dayChange`). */
export function DayFade({ dayKey, dir, children }: { dayKey: string; dir: number; children: ReactNode }) {
  const [a] = useState(() => new Animated.Value(1));
  const [shown, setShown] = useState(dayKey);
  if (shown !== dayKey) {
    setShown(dayKey);
    a.setValue(0);
  }
  useEffect(() => {
    const anim = Animated.timing(a, {
      toValue: 1,
      duration: 180,
      easing: Easing.bezier(0.2, 0, 0, 1),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [a, shown]);
  return (
    <Animated.View
      testID="today-day"
      style={{
        opacity: a,
        transform: [{ translateX: a.interpolate({ inputRange: [0, 1], outputRange: [8 * dir, 0] }) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

function Illustration({ past, large }: { past: boolean; large: boolean }) {
  const theme = useTheme();
  const st = stickerColors[theme.scheme === 'dark' ? 'dark' : 'light'];
  const size = large ? 88 : 112;
  const ink = theme.colors.ink;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 112 112"
      fill="none"
      stroke={ink}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {past ? (
        <>
          <Path
            d="M26 34a12 12 0 0 1 12-12h36a12 12 0 0 1 12 12v40a12 12 0 0 1-12 12H38a12 12 0 0 1-12-12z"
            fill={st.rose}
          />
          <Path d="M26 40h60M40 16v12M72 16v12" />
          <Path d="M44 62l8 8 16-16" strokeOpacity={0.5} />
        </>
      ) : (
        <>
          <Rect x="30" y="20" width="62" height="66" rx="12" transform="rotate(8 61 53)" fill={st.sky} />
          <Path
            d="M22 32a12 12 0 0 1 12-12h40l12 12v44a12 12 0 0 1-12 12H34a12 12 0 0 1-12-12z"
            transform="rotate(-6 54 54)"
            fill={st.lemon}
          />
          <Path d="M74 20v8a4 4 0 0 0 4 4h8" transform="rotate(-6 54 54)" />
          <Path d="M36 50h26M36 60h18" transform="rotate(-6 54 54)" strokeOpacity={0.35} />
          <Circle cx="88" cy="88" r="13" fill={theme.colors.paper} />
          <Path d="M88 82v12M82 88h12" />
        </>
      )}
    </Svg>
  );
}

/** An empty day: a future one invites to add (the button only focuses the line), a past one is quiet. */
export function EmptyDay({ weekday, past, onAdd }: { weekday: number; past: boolean; onAdd: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const large = theme.m.largeText;
  return (
    <View testID={past ? 'today-day-empty-past' : 'today-day-empty'} style={{ alignItems: 'center', paddingTop: 26 }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Illustration past={past} large={large} />
      </View>
      <AppText
        accessibilityRole="header"
        style={{
          marginTop: 18,
          textAlign: 'center',
          fontFamily: theme.type.headline.fontFamily,
          fontSize: large ? 24 : 20,
          lineHeight: large ? 30 : 25,
          color: theme.colors.ink,
        }}
      >
        {past ? t('today.dv_past_title') : t(`today.dv_title_${weekday}`)}
      </AppText>
      <AppText
        style={{
          marginTop: 8,
          maxWidth: 290,
          textAlign: 'center',
          fontSize: 16,
          lineHeight: 22,
          color: theme.colors.ink2,
        }}
      >
        {past ? t('today.dv_past_text') : t(`today.dv_text_${weekday}`)}
      </AppText>
      {past ? (
        <AppText variant="caption" style={{ marginTop: 20, textAlign: 'center', color: theme.colors.ink3 }}>
          {t('today.dv_swipe')}
        </AppText>
      ) : (
        <View style={{ marginTop: 20, width: '100%', maxWidth: 300 }}>
          <Button
            testID="today-day-add"
            label={t(`today.dv_add_${weekday}`)}
            icon={<Plus size={20} color={theme.colors.onBtn} strokeWidth={2.4} />}
            onPress={onAdd}
          />
        </View>
      )}
    </View>
  );
}

export type DayRow = { key: string; time: string; title: string; done?: boolean };

/** «План дня» (time in the 56 column) and «Без времени» of a day that is not today. */
export function DayRows({
  title,
  rows,
  first,
  testID,
}: {
  title: string;
  rows: DayRow[];
  first?: boolean;
  testID: string;
}) {
  const theme = useTheme();
  if (rows.length === 0) return null;
  return (
    <View testID={testID}>
      <SectionHead first={first} title={title} right={String(rows.length)} />
      {rows.map((r, i) => (
        <Row key={r.key} first={i === 0}>
          {r.time ? (
            <AppText
              numberOfLines={1}
              nativeID="v5-one-line"
              style={[theme.type.planTime, { width: planGeometry.timeColumn - 12 }]}
            >
              {r.time}
            </AppText>
          ) : null}
          <AppText
            numberOfLines={1}
            style={[
              { flex: 1 },
              r.done
                ? {
                    color: theme.colors.ink3,
                    textDecorationLine: 'line-through',
                    textDecorationColor: theme.colors.ink3,
                  }
                : null,
            ]}
          >
            {r.title}
          </AppText>
        </Row>
      ))}
    </View>
  );
}

/** «Сохранили» / «Потратили» of a past day: a place tab, the title, the meta. */
export function PlaceRows({
  title,
  rows,
  place,
  first,
  testID,
}: {
  title: string;
  rows: { key: string; title: string; meta?: string }[];
  place: PlaceKey;
  first?: boolean;
  testID: string;
}) {
  if (rows.length === 0) return null;
  return (
    <View testID={testID}>
      <SectionHead first={first} title={title} right={String(rows.length)} />
      {rows.map((r, i) => (
        <Row key={r.key} first={i === 0}>
          <PlaceTab place={place} />
          <AppText numberOfLines={1} style={{ flex: 1 }}>
            {r.title}
          </AppText>
          {r.meta ? <RowMeta>{r.meta}</RowMeta> : null}
        </Row>
      ))}
    </View>
  );
}
