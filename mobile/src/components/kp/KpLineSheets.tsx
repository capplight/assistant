import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { priceText, qtyText } from '@/kp/calc';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import { Sheet } from '../page/ExpenseParts';
import { KpTextField } from './KpEdits';

/**
 * Week 15 (the founder's father's КП): lump-sum lines — «Наименование | Объём | Стоимость, ₸»,
 * «Объём» free text («1 здание», «на срок работ (40 дней)»), one amount, nothing multiplied.
 * Quantity × price lines stay as they were.
 */

/** «Объём» of a line, as text. */
export function VolumeSheet({ name, initial, onSave, onClose }: { name: string; initial: string; onSave: (v: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState(initial);
  return (
    <Sheet testID="kp-volume" title={t('kp.volume_title', { name })} onClose={onClose}>
      <KpTextField testID="kp-volume-input" label={t('kp.volume')} placeholder={t('kp.volume_hint')} value={v} onChangeText={setV} />
      <Button testID="kp-volume-save" label={t('kp.save')} onPress={() => onSave(v)} />
    </Sheet>
  );
}

export type NewLine = { kind: 'qty' | 'lump'; name: string; volume: string | null; unit: string | null; qty: string | null; unit_price: string | null };

/** «+ Добавить строку»: «Объём и стоимость» (a lump sum) or «Количество × цена». */
export function AddLineSheet({ defaultKind, onSave, onClose }: { defaultKind: 'qty' | 'lump'; onSave: (l: NewLine) => boolean; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [kind, setKind] = useState<'qty' | 'lump'>(defaultKind);
  const [name, setName] = useState('');
  const [volume, setVolume] = useState('');
  const [unit, setUnit] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const lump = kind === 'lump';

  const save = () => {
    if (!name.trim()) return setError(t('kp.add_need_name'));
    if (price.trim() && priceText(price) === null) return setError(t('kp.add_bad_price'));
    if (!lump && qtyText(qty) === null) return setError(t('kp.add_bad_qty'));
    const ok = onSave({ kind, name, volume: lump ? volume : null, unit: lump ? null : unit, qty: lump ? '1' : qty, unit_price: price.trim() || null });
    if (!ok) setError(t('kp.add_bad_price'));
  };

  return (
    <Sheet testID="kp-add" title={t('kp.add_line')} onClose={onClose}>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {(['lump', 'qty'] as const).map((k) => (
          <Pressable
            key={k}
            testID={`kp-add-kind-${k}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: kind === k }}
            onPress={() => setKind(k)}
            style={{
              flexGrow: 1,
              minHeight: theme.size.buttonHeight,
              justifyContent: 'center',
              paddingHorizontal: theme.space[3],
              borderRadius: theme.radius.md,
              borderWidth: 2,
              borderColor: kind === k ? theme.colors.brand : theme.colors.iconSecondary,
              backgroundColor: kind === k ? theme.colors.brand : theme.colors.surface,
            }}
          >
            <AppText color={kind === k ? 'onBrand' : 'ink'} style={{ textAlign: 'center' }}>{`${kind === k ? '● ' : '○ '}${t(`kp.add_kind_${k}`)}`}</AppText>
          </Pressable>
        ))}
      </View>
      <KpTextField testID="kp-add-name" label={t('kp.line_add_name')} value={name} onChangeText={setName} />
      {lump ? (
        <KpTextField testID="kp-add-volume" label={t('kp.volume')} placeholder={t('kp.volume_hint')} value={volume} onChangeText={setVolume} />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
          <View style={{ flexGrow: 1, minWidth: 120 }}>
            <KpTextField testID="kp-add-qty" label={t('kp.add_qty')} value={qty} onChangeText={setQty} keyboardType="decimal-pad" />
          </View>
          <View style={{ flexGrow: 1, minWidth: 120 }}>
            <KpTextField testID="kp-add-unit" label={t('kp.line_add_unit')} value={unit} onChangeText={setUnit} />
          </View>
        </View>
      )}
      <KpTextField testID="kp-add-price" label={lump ? t('kp.add_amount') : t('kp.line_add_price')} value={price} onChangeText={setPrice} keyboardType="decimal-pad" />
      {error ? (
        <AppText testID="kp-add-error" color="warning" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
      <Button testID="kp-add-save" label={t('kp.line_add_save')} onPress={save} />
    </Sheet>
  );
}
