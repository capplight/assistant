import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import type { KpVersionRowOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/Screen';
import { StandaloneUndoStrip } from '@/components/UndoStrip';
import { decToMinor } from '@/kp/calc';
import { loadVersions } from '@/kp/service';
import { sentVersion, useKp } from '@/kp/store';
import { kpTitle, money, shortDate } from '@/kp/view';
import { useTheme } from '@/theme';

/**
 * Week 15 (S17 «Версии (3) ›», 3-engineering 6.7 п. 7): every version of a КП, newest first —
 * who made it (a tap, a phrase, «Вернуть»), its total (the server's), and the one sent to the
 * client, marked and frozen. A tap opens the version as it was, with «Вернуть эту».
 * Offline: the list the phone saw last, else the versions it holds.
 */
export default function KpVersionsScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { doc: docId } = useLocalSearchParams<{ doc: string }>();
  const doc = useKp((s) => s.docs[docId]);
  const history = useKp((s) => s.history[docId]);
  const oldVersions = useKp((s) => s.oldVersions);
  const sentEdits = useKp((s) => s.sentEdits);
  const [state, setState] = useState<'loading' | 'ok' | 'offline'>('loading');

  useEffect(() => {
    void loadVersions(docId).then((ok) => setState(ok ? 'ok' : 'offline'));
  }, [docId]);

  const back = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/kp/[id]', params: { id: docId } }));
  const sentN = doc ? sentVersion(doc, { sentEdits }) : null;
  const current = doc?.current_version_n ?? null;

  // The server's list; without it, the versions the phone holds (each frozen once made).
  const rows: KpVersionRowOut[] =
    history?.versions ??
    Object.entries(oldVersions)
      .filter(([k]) => k.startsWith(`${docId}#`))
      .map(([, v]) => ({
        n: v.n,
        author: v.author,
        author_text: null,
        created_at: v.created_at,
        total: v.totals?.total ?? null,
        missing_prices: v.totals?.missing ?? 0,
        changed_paths: v.changed_paths,
        sent_at: v.sent_at,
        sent_channel: v.sent_channel,
        frozen: v.frozen,
        current: v.n === current,
        request_text: v.request_text,
      }))
      .sort((a, b) => b.n - a.n);

  const who = (r: KpVersionRowOut) => {
    if (r.author === 'agent_request') return r.request_text ? t('kp.v_by_phrase', { text: r.request_text }) : t('kp.v_by_phrase_plain');
    return t(`kp.v_by_${r.author}`, { defaultValue: t('kp.v_by_tap_edit') });
  };

  return (
    <View style={{ flex: 1 }}>
      <Screen testID="kp-versions-screen">
        <View style={{ gap: theme.space[4] }}>
          <Button testID="kp-versions-back" label={`‹ ${t('kp.back')}`} variant="text" minHeight={theme.size.minTouch} style={{ alignSelf: 'flex-start' }} onPress={back} />
          <AppText variant="largeTitle" accessibilityRole="header">
            {doc ? `${t('kp.versions_title')} · ${kpTitle(doc, t)}` : t('kp.versions_title')}
          </AppText>
          {state === 'offline' ? (
            <AppText testID="kp-versions-offline" variant="callout">
              {t('kp.versions_offline')}
            </AppText>
          ) : null}
          {rows.length === 0 ? (
            <AppText testID="kp-versions-empty">{state === 'loading' ? t('kp.versions_loading') : t('kp.versions_none')}</AppText>
          ) : null}
          {rows.map((r) => {
            const isCurrent = r.current || r.n === current;
            const isSent = r.n === sentN;
            const total = r.total ? decToMinor(r.total) : null;
            const marks = [
              isCurrent ? t('kp.v_current') : null,
              isSent ? t('kp.v_sent', { date: shortDate(r.sent_at ?? sentEdits[docId]?.at ?? null, i18n.language) }).trim() : null,
            ].filter(Boolean);
            const line1 = [t('kp.version_n', { n: r.n }), ...marks].join(' · ');
            const line2 = [shortDate(r.created_at, i18n.language), who(r)].filter(Boolean).join(' · ');
            const sum = total !== null ? money(total) : t('kp.v_no_total');
            return (
              <Pressable
                key={r.n}
                testID={`kp-v-${r.n}`}
                accessibilityRole="button"
                accessibilityLabel={`${line1}. ${line2}. ${sum}`}
                accessibilityHint={t('kp.v_open_hint')}
                onPress={() => router.push({ pathname: '/kp/version', params: { doc: docId, n: String(r.n) } })}
                style={({ pressed }) => ({
                  minHeight: theme.size.buttonHeight,
                  padding: theme.space[3],
                  gap: theme.space[1],
                  borderRadius: theme.radius.lg,
                  borderWidth: isSent ? 2 : 1,
                  borderColor: isSent ? theme.colors.success : theme.colors.separator,
                  backgroundColor: pressed ? theme.colors.separator : theme.colors.surface,
                })}
              >
                <AppText variant="bodyStrong">{line1}</AppText>
                <AppText variant="callout">{line2}</AppText>
                <AppText variant="number" style={{ fontVariant: ['tabular-nums'] }}>
                  {sum}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </Screen>
      <StandaloneUndoStrip />
    </View>
  );
}
