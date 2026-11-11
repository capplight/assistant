import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, StyleSheet, Switch, TextInput, View } from 'react-native';

import type { LegalForm } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { CheckBadge } from '@/components/kp/KpParts';
import { ChoiceSheet } from '@/components/page/FieldSheets';
import { Screen } from '@/components/Screen';
import { StandaloneUndoStrip } from '@/components/UndoStrip';
import { getMedia } from '@/expenses/media';
import { editProfile, refreshProfile, setProfileImage, verifyProfileField } from '@/kp/service';
import { shownProfile, useKp, type ProfileFields, type ProfileImageRole } from '@/kp/store';
import { useToast } from '@/store/toast';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

type TextKey = Exclude<keyof ProfileFields, 'vat_payer' | 'legal_form'>;
const MAIN: TextKey[] = ['name', 'bin_iin', 'address', 'phone', 'email'];
const BANK: TextKey[] = ['iban', 'bik', 'bank_name', 'kbe'];
const NUMERIC = new Set<TextKey>(['bin_iin', 'phone', 'kbe', 'outgoing_next']);
/** Week 15 (the founder's father's КП): the signer block and the licence line of the intro. */
const SIGNER_KEYS: TextKey[] = ['signer_title', 'signer_name'];
const LICENSE_KEYS: TextKey[] = ['license_number', 'license_date', 'license_category'];

/** «15.01.2020» ↔ ISO «2020-01-15» (the licence date as the person writes it). */
const isoDay = (v: string): string | null => {
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(v.trim());
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
};
const shownDay = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('.') : (iso ?? ''));
const LEGAL = ['ip', 'too', 'ao', 'other'] as const;
const ROLES: ProfileImageRole[] = ['logo', 'signature', 'stamp'];

/**
 * S19 «Моя компания» (week 14): the seller's details that every КП carries (Ф-17), the VAT
 * (Ф-18: 16 %, «в сумме» / «сверху» / «без НДС»), the logo, the signature and the stamp — those
 * originals are always kept (R-34, `files.role`). Each field is saved when the person leaves it, at
 * once and offline too, with «Отменить». A number read from a photo shows «проверьте» until «Верно».
 */
export default function CompanyScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const saved = useKp((s) => s.profile);
  const edit = useKp((s) => s.profileEdit);
  const images = useKp((s) => s.images);
  const shown = shownProfile({ profile: saved, profileEdit: edit });
  const [draft, setDraft] = useState<Partial<Record<TextKey, string>>>({});
  const [legalOpen, setLegalOpen] = useState(false);

  useEffect(() => {
    void refreshProfile();
  }, []);

  const valueOf = (k: TextKey) => draft[k] ?? (k === 'license_date' ? shownDay(shown[k]) : (shown[k] ?? ''));
  const commit = (k: TextKey) => {
    const v = draft[k];
    if (v === undefined) return;
    setDraft((d) => {
      const n = { ...d };
      delete n[k];
      return n;
    });
    let next = v.trim() || null;
    if (k === 'license_date' && next) {
      next = isoDay(next);
      if (!next) return useToast.getState().show(t('kp.license_date_bad'), 4000);
    }
    if (k === 'outgoing_next' && next && !/^\d{1,6}$/.test(next)) return useToast.getState().show(t('kp.outgoing_bad'), 4000);
    if (next !== (shown[k] ?? null)) void editProfile({ [k]: next } as Partial<ProfileFields>);
  };

  const field = (k: TextKey) => {
    const review = shown.review_fields.includes(k);
    return (
      <View key={k} style={{ gap: theme.space[1] }}>
        <AppText variant="meta">{t(`kp.f_${k}`)}</AppText>
        <TextInput
          testID={`company-${k}`}
          accessibilityLabel={t(`kp.f_${k}`)}
          value={valueOf(k)}
          onChangeText={(x) => setDraft((d) => ({ ...d, [k]: x }))}
          onEndEditing={() => commit(k)}
          onBlur={() => commit(k)}
          keyboardType={NUMERIC.has(k) ? 'number-pad' : k === 'email' ? 'email-address' : 'default'}
          autoCapitalize={k === 'email' ? 'none' : 'sentences'}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            theme.type.body,
            {
              color: theme.colors.ink,
              minHeight: theme.size.primaryTouch,
              borderWidth: 1,
              borderColor: review ? theme.colors.warnText : theme.colors.lineStrong,
              borderRadius: theme.radius.input,
              paddingHorizontal: theme.space[3],
              backgroundColor: review ? theme.colors.markerSoft : theme.colors.surface,
            },
          ]}
        />
        {review ? (
          <View style={[styles.row, { gap: theme.space[2] }]}>
            <CheckBadge testID={`company-${k}-check`} />
            <Button testID={`company-${k}-verify`} label={t('kp.verify')} variant="text" minHeight={theme.size.minTouch} onPress={() => void verifyProfileField(k)} />
          </View>
        ) : null}
      </View>
    );
  };

  const pickImage = async (role: ProfileImageRole) => {
    try {
      const m = await getMedia().pickPhoto();
      if (m) await setProfileImage(role, m);
    } catch (e) {
      console.warn('company image pick failed', e);
      useToast.getState().show(t('exp.pick_failed'), 4000);
    }
  };

  return (
    <View style={styles.root}>
      <Screen testID="company-screen">
        <View style={{ gap: theme.space[4] }}>
          <Button testID="company-back" label={`‹ ${t('kp.back')}`} variant="text" minHeight={theme.size.minTouch} style={{ alignSelf: 'flex-start' }} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
          <AppText variant="title1" accessibilityRole="header">
            {t('kp.company_title')}
          </AppText>
          <AppText variant="meta">{t('kp.company_hint')}</AppText>
          {field('name')}
          <View style={{ gap: theme.space[1] }}>
            <AppText variant="meta">{t('kp.f_legal_form')}</AppText>
            <Button
              testID="company-legal_form"
              label={shown.legal_form ? t(`kp.lf_${shown.legal_form}`, { defaultValue: shown.legal_form }) : t('kp.client_none')}
              variant="outline"
              onPress={() => setLegalOpen(true)}
            />
          </View>
          {MAIN.slice(1).map(field)}
          <AppText variant="section" accessibilityRole="header">
            {t('kp.bank_title')}
          </AppText>
          {BANK.map(field)}
          <AppText variant="section" accessibilityRole="header">
            {t('kp.signer_title')}
          </AppText>
          {SIGNER_KEYS.map(field)}
          <AppText variant="section" accessibilityRole="header">
            {t('kp.license_title')}
          </AppText>
          <AppText variant="meta">{t('kp.license_hint')}</AppText>
          {LICENSE_KEYS.map(field)}
          <AppText variant="section" accessibilityRole="header">
            {t('kp.outgoing_title')}
          </AppText>
          <AppText variant="meta">{t('kp.outgoing_hint')}</AppText>
          {field('outgoing_next')}

          <View style={[styles.row, { gap: theme.space[3], minHeight: theme.size.primaryTouch }]}>
            <AppText style={{ flex: 1 }}>{t('kp.vat_payer')}</AppText>
            <Switch
              testID="company-vat-payer"
              accessibilityLabel={t('kp.vat_payer')}
              value={shown.vat_payer === true}
              onValueChange={(on) => void editProfile({ vat_payer: on })}
            />
          </View>

          <AppText variant="section" accessibilityRole="header">
            {t('kp.images_title')}
          </AppText>
          <AppText testID="company-images-kept" variant="meta">
            {t('kp.images_kept')}
          </AppText>
          {ROLES.map((role) => {
            const img = images[role];
            const has = !!img || !!saved?.[`${role}_file_id` as const];
            return (
              <View key={role} testID={`company-img-${role}`} style={[styles.row, { gap: theme.space[3], flexWrap: 'wrap' }]}>
                {img ? (
                  <Image source={{ uri: img.uri }} accessibilityIgnoresInvertColors style={{ width: 64, height: 64, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.line }} />
                ) : (
                  <View style={{ width: 64, height: 64, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.lineStrong }} />
                )}
                <View style={{ flex: 1, minWidth: 140, gap: theme.space[1] }}>
                  <AppText variant="bodyStrong">{t(`kp.img_${role}`)}</AppText>
                  <AppText testID={`company-img-${role}-state`} variant="meta">
                    {img ? (img.state === 'sent' ? t('kp.img_sent') : t('kp.img_waiting')) : has ? t('kp.img_sent') : t('kp.img_none')}
                  </AppText>
                </View>
                <Button
                  testID={`company-img-${role}-pick`}
                  label={has ? t('kp.img_replace') : t('kp.img_pick')}
                  accessibilityLabel={`${has ? t('kp.img_replace') : t('kp.img_pick')}: ${t(`kp.img_${role}`)}`}
                  variant="outline"
                  minHeight={theme.size.minTouch}
                  onPress={() => void pickImage(role)}
                />
              </View>
            );
          })}

          <Button testID="company-prices" label={`${t('kp.my_prices')} ›`} variant="outline" onPress={() => router.push('/price-list')} />
        </View>
      </Screen>
      <StandaloneUndoStrip />
      {legalOpen ? (
        <ChoiceSheet
          testID="company-legal-sheet"
          title={t('kp.f_legal_form')}
          options={LEGAL.map((k) => ({ key: k, label: t(`kp.lf_${k}`) }))}
          value={shown.legal_form ?? ''}
          onPick={(k) => {
            setLegalOpen(false);
            void editProfile({ legal_form: k as LegalForm });
          }}
          onClose={() => setLegalOpen(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
