import { Check } from 'lucide-react-native';
import { View } from 'react-native';

import { AppText } from '../AppText';
import { Button } from './Button';
import { useTheme } from '@/theme';

/**
 * screens-v5-extra `.steps` (Telegram / Переписки / Будильник): numbers in 28 circles with a 1.5 ink ring, one action a
 * row, thin rules between; a done step is a black circle with a tick.
 */
export function StepList({
  steps,
  testID,
}: {
  steps: { text: string; hint?: string; done?: boolean }[];
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View testID={testID}>
      {steps.map((s, i) => (
        <View
          key={i}
          testID={testID ? `${testID}-${i + 1}` : undefined}
          accessible
          accessibilityLabel={`${i + 1}. ${s.text}${s.hint ? `. ${s.hint}` : ''}`}
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 12,
            paddingVertical: 10,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <View
            style={[
              {
                minWidth: 28,
                minHeight: 28,
                paddingHorizontal: 4,
                borderRadius: 14,
                alignItems: 'center',
                justifyContent: 'center',
              },
              s.done ? { backgroundColor: theme.colors.ink } : { borderWidth: 1.5, borderColor: theme.colors.ink },
            ]}
          >
            {s.done ? (
              <Check size={16} color={theme.colors.paper} strokeWidth={3} />
            ) : (
              <AppText
                style={{
                  fontFamily: theme.type.stripTitle.fontFamily,
                  fontSize: 14,
                  lineHeight: 17,
                  fontVariant: ['tabular-nums'],
                }}
              >
                {String(i + 1)}
              </AppText>
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText style={{ fontSize: 16, lineHeight: 22 }}>{s.text}</AppText>
            {s.hint ? (
              <AppText variant="footnote" style={{ color: theme.colors.ink3 }}>
                {s.hint}
              </AppText>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * screens-v5-extra «Telegram · идёт перенос»: a paper2 plate r16 — «Переношу…» and the percent, an 8 high bar in the
 * text colour, «1 240 из 3 180 заметок», «можно закрыть — продолжу сам» and «Остановить».
 */
export function ProgressPlate({
  title,
  share,
  count,
  note,
  stopLabel,
  onStop,
  testID,
  stopTestID,
  barTestID,
}: {
  title: string;
  share: number | null;
  count?: string | null;
  note?: string | null;
  stopLabel?: string;
  onStop?: () => void;
  testID?: string;
  stopTestID?: string;
  barTestID?: string;
}) {
  const theme = useTheme();
  const pct = share === null ? null : Math.max(0, Math.min(100, Math.round(share * 100)));
  return (
    <View
      testID={testID}
      accessibilityLiveRegion="polite"
      style={{ backgroundColor: theme.colors.paper2, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <AppText style={{ flex: 1, fontFamily: theme.type.headline.fontFamily, fontSize: 16, lineHeight: 20 }}>
          {title}
        </AppText>
        {pct !== null ? (
          <AppText
            style={{
              fontFamily: theme.type.headline.fontFamily,
              fontSize: 16,
              lineHeight: 20,
              fontVariant: ['tabular-nums'],
            }}
          >{`${pct}%`}</AppText>
        ) : null}
      </View>
      {pct !== null ? (
        <View
          testID={barTestID}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: pct }}
          style={{
            height: 8,
            borderRadius: 4,
            backgroundColor: theme.colors.line,
            overflow: 'hidden',
            marginTop: 10,
            marginBottom: 8,
          }}
        >
          <View style={{ width: `${pct}%`, height: '100%', borderRadius: 4, backgroundColor: theme.colors.ink }} />
        </View>
      ) : null}
      {count ? (
        <AppText variant="small" style={{ fontVariant: ['tabular-nums'], marginTop: pct === null ? 6 : 0 }}>
          {count}
        </AppText>
      ) : null}
      {note ? (
        <AppText variant="footnote" style={{ color: theme.colors.ink3, marginTop: 2 }}>
          {note}
        </AppText>
      ) : null}
      {onStop && stopLabel ? (
        <View style={{ alignItems: 'flex-start', marginTop: 12 }}>
          <Button
            testID={stopTestID}
            label={stopLabel}
            variant="secondary"
            size="small"
            minHeight={42}
            onPress={onStop}
          />
        </View>
      ) : null}
    </View>
  );
}
