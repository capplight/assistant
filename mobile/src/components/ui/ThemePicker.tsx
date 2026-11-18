import { Check, Moon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { useTheme, type SchemePreference } from '@/theme';

import { AppText } from '../AppText';
import { Row, RowChevron, RowMeta } from './Leaf';
import { Sheet } from './Sheet';

/**
 * screens-v5 «Настройки → Тема» (QA v5-device-1 B «Настройки» 1): one row «Тема · как в телефоне ›»; its sheet has
 * three choices — «Светлая», «Тёмная», «Как в телефоне» — with a check on the chosen one. No v2 previews.
 */
export function ThemePicker({
  preference,
  onChange,
  labels,
}: {
  preference: SchemePreference;
  onChange: (p: SchemePreference) => void;
  labels: { light: string; dark: string; system: string; systemHint: string; title?: string };
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const options: { key: SchemePreference; label: string }[] = [
    { key: 'light', label: labels.light },
    { key: 'dark', label: labels.dark },
    { key: 'system', label: labels.system },
  ];
  const current = options.find((o) => o.key === preference)?.label ?? labels.system;
  return (
    <>
      <Row first testID="theme-row" onPress={() => setOpen(true)} accessibilityLabel={`${labels.title ?? ''} ${current}`}>
        <Moon size={22} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
        <AppText style={{ flex: 1 }} numberOfLines={1}>
          {labels.title ?? labels.system}
        </AppText>
        <RowMeta>{current.toLowerCase()}</RowMeta>
        <RowChevron />
      </Row>
      <Sheet visible={open} onClose={() => setOpen(false)} title={labels.title} testID="theme-sheet">
        <View accessibilityRole="radiogroup">
          {options.map((o, i) => {
            const on = o.key === preference;
            return (
              <Pressable
                key={o.key}
                testID={`theme-${o.key}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={o.label}
                accessibilityHint={o.key === 'system' ? labels.systemHint : undefined}
                onPress={() => onChange(o.key)}
                style={({ pressed }) => [
                  { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: theme.m.row, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.colors.line },
                  pressed ? { backgroundColor: theme.colors.paper2 } : null,
                ]}
              >
                <AppText style={{ flex: 1 }}>{o.label}</AppText>
                {on ? <Check size={20} color={theme.colors.ink} strokeWidth={2.4} /> : null}
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    </>
  );
}
