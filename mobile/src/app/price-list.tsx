import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { PriceItemOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { CheckBadge } from '@/components/kp/KpParts';
import { NumberSheet } from '@/components/kp/NumberSheet';
import { Sheet } from '@/components/page/ExpenseParts';
import { Screen } from '@/components/Screen';
import { Header } from '@/components/ui/Header';
import { StandaloneUndoStrip } from '@/components/UndoStrip';
import { priceText } from '@/kp/calc';
import { addPrices, changePrice, refreshPrices, removePrice } from '@/kp/service';
import { shownPrices, useKp } from '@/kp/store';
import { priceMoney, shortDate } from '@/kp/view';
import { fold } from '@/records/search';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

/**
 * S28 «Мой прайс» (F-34, week 14): the prices the КП takes first (3-engineering 6.7 п. 2). Find,
 * change a price on the big keys, «Верно» on a price read from a file, remove; «Из прошлых КП»
 * with «Добавить в прайс»; «Добавить цену» one after another. All of it offline and in «Без ИИ»,
 * each change with «Отменить». Reading a price list from Excel / PDF / a photo is the server's.
 */
export default function PriceListScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const prices = useKp((s) => s.prices);
  const past = useKp((s) => s.pastPrices);
  const updatedAt = useKp((s) => s.pricesUpdatedAt);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<PriceItemOut | null>(null);
  const [menu, setMenu] = useState<PriceItemOut | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void refreshPrices();
  }, []);

  const list = useMemo(() => shownPrices(prices), [prices]);
  const found = useMemo(() => {
    const k = fold(q.trim());
    return k ? list.filter((p) => fold(p.name).includes(k)) : list;
  }, [list, q]);
  const inList = new Set(list.map((p) => p.name.trim().toLowerCase()));
  const pastShown = past.filter((p) => !inList.has(p.name.trim().toLowerCase()));
  const unit = (p: { unit: string | null }) => (p.unit ? t('kp.per_unit', { unit: p.unit }) : '');

  return (
    <View style={styles.root}>
      <Screen testID="prices-screen">
        <View style={{ gap: theme.space[4] }}>
          <Header title={t('kp.prices_screen')} back={{ testID: 'prices-back', label: t('kp.back'), onPress: () => (router.canGoBack() ? router.back() : router.replace('/')) }} />
          <AppText testID="prices-count" variant="callout">
            {[t('kp.prices_count', { count: list.length }), updatedAt ? t('kp.prices_updated', { date: shortDate(updatedAt, i18n.language) }) : null].filter(Boolean).join(' · ')}
          </AppText>
          <Button testID="prices-add" label={t('kp.add_one')} onPress={() => setAdding(true)} />
          {list.length > 0 ? (
            <TextInput
              testID="prices-find"
              accessibilityLabel={t('kp.prices_find')}
              placeholder={t('kp.prices_find')}
              placeholderTextColor={theme.colors.ink2}
              value={q}
              onChangeText={setQ}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={[theme.type.body, { color: theme.colors.ink, minHeight: theme.size.buttonHeight, borderRadius: theme.radius.sm, paddingHorizontal: theme.space[3], backgroundColor: theme.colors.surfaceSunken }]}
            />
          ) : (
            <AppText testID="prices-empty">{t('kp.prices_empty')}</AppText>
          )}
          {q && found.length === 0 ? <AppText testID="prices-none">{t('kp.prices_none_found')}</AppText> : null}
          {found.map((p) => (
            <Pressable
              key={p.id}
              testID={`price-${p.name}`}
              accessibilityRole="button"
              accessibilityLabel={t('kp.price_row_a11y', { name: p.name, price: priceMoney(p.price), unit: p.unit ? t('kp.per_unit_a11y', { unit: p.unit }) : '', review: p.review ? t('kp.check') : '' })}
              onPress={() => setMenu(p)}
              style={{ minHeight: theme.size.buttonHeight, borderBottomWidth: 1, borderBottomColor: theme.colors.separator, paddingVertical: theme.space[2], gap: theme.space[1] }}
            >
              <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
                <AppText style={{ flexGrow: 1, flexShrink: 1 }}>{p.name}</AppText>
                <AppText variant="number" style={{ backgroundColor: p.review ? theme.colors.highlightTint : 'transparent' }}>{`${priceMoney(p.price)}${unit(p)} ›`}</AppText>
              </View>
              {p.review ? <CheckBadge /> : null}
            </Pressable>
          ))}
          {pastShown.length > 0 ? (
            <>
              <AppText variant="sectionLabel" accessibilityRole="header" style={{ marginTop: theme.space[4] }}>
                {t('kp.prices_past', { count: pastShown.length })}
              </AppText>
              {pastShown.map((p) => (
                <View key={`${p.name}|${p.unit ?? ""}`} testID={`price-past-${p.name}`} style={{ gap: theme.space[1], borderBottomWidth: 1, borderBottomColor: theme.colors.separator, paddingVertical: theme.space[2] }}>
                  <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
                    <AppText style={{ flexGrow: 1, flexShrink: 1 }}>{p.name}</AppText>
                    <AppText variant="number">{`${priceMoney(p.price)}${unit(p)}`}</AppText>
                  </View>
                  {p.client ? <AppText variant="callout">{t('kp.past_from', { client: p.client })}</AppText> : null}
                  <Button
                    testID={`price-past-${p.name}-add`}
                    label={t('kp.prices_add_to_list')}
                    accessibilityLabel={`${t('kp.prices_add_to_list')}: ${p.name}`}
                    variant="secondary"
                    minHeight={theme.size.minTouch}
                    onPress={() => void addPrices([{ name: p.name, unit: p.unit, price: p.price }])}
                  />
                </View>
              ))}
            </>
          ) : null}
        </View>
      </Screen>
      <StandaloneUndoStrip />

      {menu ? (
        <Sheet testID="price-menu" title={menu.name} onClose={() => setMenu(null)}>
          <AppText variant="number">{`${priceMoney(menu.price)}${unit(menu)}`}</AppText>
          <Button testID="price-menu-change" label={t('kp.change_price', { price: priceMoney(menu.price) })} onPress={() => { setEditing(menu); setMenu(null); }} />
          {menu.review ? (
            <Button testID="price-menu-verify" label={t('kp.verify')} variant="secondary" onPress={() => { void changePrice(menu.id, {}, { verify: true }); setMenu(null); }} />
          ) : null}
          <Button testID="price-menu-delete" label={t('kp.price_edit_delete')} variant="text" labelColor="danger" onPress={() => { void removePrice(menu.id); setMenu(null); }} />
        </Sheet>
      ) : null}
      {editing ? (
        <NumberSheet
          testID="price-edit"
          title={t('kp.edit_title_price', { name: editing.name })}
          initial={editing.price}
          unit={editing.unit}
          money
          onClose={() => setEditing(null)}
          onSave={(text) => {
            const v = priceText(text);
            if (v === null || v === '0.00') return false;
            void changePrice(editing.id, { price: v });
            setEditing(null);
            return true;
          }}
        />
      ) : null}
      {adding ? <AddPriceSheet onClose={() => setAdding(false)} /> : null}
    </View>
  );
}

/** «Добавить цену»: the name, the unit, the price; «Добавить» keeps the sheet open for the next one. */
function AddPriceSheet({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [price, setPrice] = useState('');
  const [bad, setBad] = useState(false);
  const input = (testID: string, label: string, value: string, set: (s: string) => void, numeric = false) => (
    <View style={{ gap: theme.space[1] }}>
      <AppText variant="callout">{label}</AppText>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={(s) => {
          setBad(false);
          set(s);
        }}
        keyboardType={numeric ? 'decimal-pad' : 'default'}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={[theme.type.body, { color: theme.colors.ink, minHeight: theme.size.buttonHeight, borderRadius: theme.radius.sm, paddingHorizontal: theme.space[3], backgroundColor: theme.colors.surfaceSunken }]}
      />
    </View>
  );
  return (
    <Sheet testID="price-add" title={t('kp.add_title')} onClose={onClose}>
      {input('price-add-name', t('kp.add_name'), name, setName)}
      {input('price-add-unit', t('kp.add_unit'), unit, setUnit)}
      {input('price-add-price', t('kp.add_price'), price, setPrice, true)}
      {bad ? (
        <AppText testID="price-add-bad" color="warning" accessibilityLiveRegion="polite">
          {t('kp.add_bad')}
        </AppText>
      ) : null}
      <Button
        testID="price-add-save"
        label={t('kp.add_save')}
        onPress={() => {
          const p = priceText(price);
          if (!name.trim() || p === null || p === '0.00') {
            setBad(true);
            return;
          }
          void addPrices([{ name, unit: unit.trim() || null, price: p }]);
          setName('');
          setUnit('');
          setPrice('');
        }}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
