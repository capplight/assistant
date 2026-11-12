import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { KpTextField } from '@/components/kp/KpEdits';
import { Screen } from '@/components/Screen';
import { assistantOn, createDraft } from '@/kp/service';
import { shownData, useKp } from '@/kp/store';
import { useTheme } from '@/theme';

/**
 * F-15: «Написать клиенту» from a КП (S17 «Ещё»): what to write, in the person's words («что КП
 * будет в пятницу»), and by what; the assistant writes it (POST /drafts with the КП). Needs the
 * internet and the assistant: otherwise the screen says so. Nothing is sent from here.
 */
export default function NewDraftScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { doc: docId } = useLocalSearchParams<{ doc?: string }>();
  const data = useKp((s) => (docId ? shownData(docId, s) : null));
  const [request, setRequest] = useState('');
  const [channel, setChannel] = useState<'whatsapp' | 'email'>('whatsapp');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const name = data?.client.contact?.trim() || data?.client.name || null;

  const make = async () => {
    setBusy(true);
    setNote(null);
    const r = await createDraft(request, { documentId: docId ?? null, channel, recipientName: name });
    setBusy(false);
    if (r.result === 'ok') router.replace({ pathname: '/draft/[id]', params: { id: r.id } });
    else setNote(r.message || t(`draft.err_${r.result}`));
  };

  return (
    <Screen testID="draft-new">
      <View style={{ gap: theme.space[4] }}>
        <Button testID="draft-new-back" label={`‹ ${t('kp.back')}`} variant="text" minHeight={theme.size.minTouch} style={{ alignSelf: 'flex-start' }} onPress={close} />
        <AppText variant="largeTitle" accessibilityRole="header">
          {name ? t('draft.new_title_to', { name }) : t('draft.new_title')}
        </AppText>
        {!assistantOn() ? (
          <AppText testID="draft-new-no-ai">{t('draft.err_no_ai')}</AppText>
        ) : (
          <>
            <KpTextField testID="draft-new-request" label={t('draft.what')} placeholder={t('draft.what_hint')} value={request} onChangeText={setRequest} multiline />
            <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
              {(['whatsapp', 'email'] as const).map((c) => (
                <Pressable
                  key={c}
                  testID={`draft-new-${c}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: channel === c }}
                  onPress={() => setChannel(c)}
                  style={{
                    flexGrow: 1,
                    minHeight: theme.size.buttonHeight,
                    justifyContent: 'center',
                    paddingHorizontal: theme.space[4],
                    borderRadius: theme.radius.md,
                    borderWidth: 2,
                    borderColor: channel === c ? theme.colors.brand : theme.colors.iconSecondary,
                    backgroundColor: channel === c ? theme.colors.brand : theme.colors.surface,
                  }}
                >
                  <AppText color={channel === c ? 'onBrand' : 'ink'} style={{ textAlign: 'center' }}>
                    {`${channel === c ? '● ' : '○ '}${t(c === 'email' ? 'send.ch_email' : 'send.ch_whatsapp')}`}
                  </AppText>
                </Pressable>
              ))}
            </View>
            <Button testID="draft-new-make" label={busy ? t('draft.writing') : t('draft.make')} disabled={busy || !request.trim()} onPress={() => void make()} />
            {note ? (
              <AppText testID="draft-new-note" color="warning" accessibilityLiveRegion="polite">
                {note}
              </AppText>
            ) : null}
          </>
        )}
      </View>
    </Screen>
  );
}
