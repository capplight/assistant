import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { AppText } from '../AppText';
import { useTheme } from '@/theme';

/** Rows grow with the font (the numbers are capped at 1.3×), the band stays in the middle. */
function useSizes() {
  const theme = useTheme();
  const k = Math.min(1.3, Math.max(1, theme.m.fontScale));
  return { ITEM: Math.round(BASE_ITEM * k), HEIGHT: Math.round(BASE_HEIGHT * k) };
}

/** screens-v5-extra «Дело · редактор» `.wheel`: 124 high, three rows, the middle one on a 48 paper2 band. */
const BASE_ITEM = 41;
const BASE_HEIGHT = 124;

const pad = (n: number) => String(n).padStart(2, '0');

function Column({
  values,
  index,
  onIndex,
  label,
  testID,
}: {
  values: number[];
  index: number;
  onIndex: (i: number) => void;
  label: string;
  testID: string;
}) {
  const theme = useTheme();
  const { ITEM, HEIGHT } = useSizes();
  const ref = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const settled = useRef(index);
  // QA v5-device-3 J13: the bold number is the one in the band WHILE the wheel turns (it followed only the end of the
  // fling, ~130 ms late). It changes only when another row crosses the band, not per frame.
  const [live, setLive] = useState(index);
  const [seen, setSeen] = useState(index);
  if (seen !== index) {
    setSeen(index);
    setLive(index);
  }
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.max(0, Math.min(values.length - 1, Math.round(e.nativeEvent.contentOffset.y / ITEM)));
    setLive((was) => (was === i ? was : i));
  };
  useEffect(() => {
    if (settled.current === index) return;
    settled.current = index;
    ref.current?.scrollTo({ y: index * ITEM, animated: false });
  }, [index, ITEM]);
  const end = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.max(0, Math.min(values.length - 1, Math.round(e.nativeEvent.contentOffset.y / ITEM)));
    settled.current = i;
    if (i !== index) onIndex(i);
  };
  const step = (d: number) => onIndex((index + d + values.length) % values.length);
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: pad(values[index] ?? 0) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
      nativeID="v5-wheel"
      style={{ width: 72, height: HEIGHT }}
    >
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM}
        decelerationRate="fast"
        contentOffset={{ x: 0, y: index * ITEM }}
        contentContainerStyle={{ paddingVertical: (HEIGHT - ITEM) / 2 }}
        onMomentumScrollEnd={end}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onScrollEndDrag={(e) => {
          if (Math.abs(e.nativeEvent.velocity?.y ?? 0) < 0.05) end(e);
        }}
        nestedScrollEnabled
      >
        {values.map((v, i) => {
          const on = i === live;
          return (
            <View key={v} nativeID="v5-wheel" style={{ height: ITEM, alignItems: 'center', justifyContent: 'center' }}>
              <AppText
                maxFontSizeMultiplier={1.3}
                nativeID="v5-capped"
                style={
                  on
                    ? {
                        fontFamily: theme.type.title.fontFamily,
                        fontSize: 30,
                        lineHeight: 34,
                        color: theme.colors.ink,
                        fontVariant: ['tabular-nums'],
                      }
                    : {
                        fontFamily: theme.type.sheetMeta.fontFamily,
                        fontSize: 21,
                        lineHeight: 26,
                        color: theme.colors.ink3,
                        fontVariant: ['tabular-nums'],
                      }
                }
              >
                {pad(v)}
              </AppText>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * The time wheel of the task editor (replaces «−1:00 +1:00 −0:05 +0:05»): hours 00–23 and minutes by 5. Each column
 * scrolls and snaps; for a screen reader it is an adjustable value (swipe up / down).
 */
export function TimeWheel({
  hour,
  minute,
  onChange,
  testID = 'time-wheel',
}: {
  hour: number;
  minute: number;
  onChange: (h: number, m: number) => void;
  testID?: string;
}) {
  const theme = useTheme();
  const { HEIGHT } = useSizes();
  const { t } = useTranslation();
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);
  const mIndex = Math.round(minute / 5) % 12;
  return (
    <View testID={testID} nativeID="v5-wheel" style={[styles.wheel, { height: HEIGHT }]}>
      <View
        pointerEvents="none"
        style={[styles.band, { top: (HEIGHT - 48) / 2, backgroundColor: theme.colors.paper2 }]}
      />
      <Column
        testID={`${testID}-hour`}
        label={t('rem.wheel_hour')}
        values={hours}
        index={hour}
        onIndex={(i) => onChange(i, minutes[mIndex]!)}
      />
      <AppText
        style={{ fontFamily: theme.type.title.fontFamily, fontSize: 30, lineHeight: 34, color: theme.colors.ink }}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        :
      </AppText>
      <Column
        testID={`${testID}-minute`}
        label={t('rem.wheel_minute')}
        values={minutes}
        index={mIndex}
        onIndex={(i) => onChange(hour, minutes[i]!)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wheel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  band: { position: 'absolute', left: 0, right: 0, height: 48, borderRadius: 14 },
});
