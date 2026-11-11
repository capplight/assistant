import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, View } from 'react-native';

import { getContactsPort, type PickedContact } from '@/kp/contacts';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../Button';
import { Sheet } from '../page/ExpenseParts';
import { KpTextField } from './KpEdits';

/**
 * The client's WhatsApp number (S18, a draft): typed, or picked from the phone's contacts. Before
 * the system question the app says in plain words why and what it takes; denied → typing still
 * works. Only the chosen number goes to `onChange` (the name is shown, never kept or sent).
 */
export function ContactPhoneField({ testID, value, onChange }: { testID: string; value: string; onChange: (phone: string) => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [explain, setExplain] = useState(false);
  const [choose, setChoose] = useState<PickedContact | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const take = (c: PickedContact, number: string) => {
    setChoose(null);
    setPicked(c.name);
    setNote(null);
    onChange(number);
  };

  const pick = async () => {
    try {
      const c = await getContactsPort().pick();
      if (!c) return;
      if (c.phones.length === 0) return setNote(t('contacts.no_phone'));
      if (c.phones.length === 1) return take(c, c.phones[0]!.number);
      setChoose(c);
    } catch (e) {
      console.warn('contact pick failed', e);
      setNote(t('contacts.failed'));
    }
  };

  const start = async () => {
    setNote(null);
    let access;
    try {
      access = await getContactsPort().access();
    } catch {
      return setNote(t('contacts.failed'));
    }
    if (access === 'granted') return void pick();
    if (access === 'denied') return setNote(t('contacts.denied'));
    setExplain(true); // our words first, then the system's question
  };

  const allow = async () => {
    setExplain(false);
    const ok = await getContactsPort()
      .ask()
      .catch(() => false);
    if (ok) await pick();
    else setNote(t('contacts.declined'));
  };

  return (
    <View style={{ gap: theme.space[2] }}>
      <KpTextField testID={testID} label={t('send.phone')} value={value} onChangeText={onChange} keyboardType="phone-pad" placeholder="+7 7__ ___ __ __" />
      <Button testID={`${testID}-contacts`} label={t('contacts.pick')} variant="outline" minHeight={theme.size.minTouch} onPress={() => void start()} />
      {picked ? (
        <AppText testID={`${testID}-picked`} variant="meta">
          {t('contacts.picked', { name: picked })}
        </AppText>
      ) : null}
      <AppText variant="meta">{t('send.phone_note')}</AppText>
      {note ? (
        <View style={{ gap: theme.space[2] }}>
          <AppText testID={`${testID}-contacts-note`} color="warnText" accessibilityLiveRegion="polite">
            {note}
          </AppText>
          {note === t('contacts.denied') ? (
            <Button testID={`${testID}-contacts-settings`} label={t('contacts.settings')} variant="text" minHeight={theme.size.minTouch} onPress={() => void Linking.openSettings()} />
          ) : null}
        </View>
      ) : null}

      {explain ? (
        <Sheet testID={`${testID}-contacts-explain`} title={t('contacts.explain_title')} onClose={() => setExplain(false)}>
          <AppText>{t('contacts.explain_body')}</AppText>
          <Button testID={`${testID}-contacts-allow`} label={t('contacts.allow')} onPress={() => void allow()} />
          <Button
            testID={`${testID}-contacts-type`}
            label={t('contacts.type_instead')}
            variant="outline"
            onPress={() => {
              setExplain(false);
              setNote(t('contacts.declined'));
            }}
          />
        </Sheet>
      ) : null}
      {choose ? (
        <Sheet testID={`${testID}-contacts-choose`} title={t('contacts.choose_title', { name: choose.name ?? '' }).trim()} onClose={() => setChoose(null)}>
          {choose.phones.map((p, i) => (
            <Button
              key={`${p.number}-${i}`}
              testID={`${testID}-contacts-phone-${i}`}
              label={p.label ? `${p.number} · ${p.label}` : p.number}
              variant="outline"
              onPress={() => take(choose, p.number)}
            />
          ))}
        </Sheet>
      ) : null}
    </View>
  );
}
