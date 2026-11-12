import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet } from 'react-native';

import { liveLink, refreshExport, shareExport, startExport, untilText, useAccount } from '@/account/data';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/Screen';
import { useTheme } from '@/theme';

const POLL_MS = 5_000;

/**
 * S24 «Мои данные» (US-19, account.md): «Скачать мои данные» — the server builds a ZIP in the
 * background («Готовлю архив…», push «Архив готов»), then «Скачать (до 12 ноября, 15:01)» hands
 * the link (24 h, works without signing in) to the system share sheet. Where the data lives, and
 * the one way to delete the account (S32).
 */
export default function MyDataScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const job = useAccount((s) => s.exportJob);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const making = job?.status === 'queued' || job?.status === 'running';
  const link = liveLink(job);

  useEffect(() => {
    void refreshExport();
    if (!making) return;
    const id = setInterval(() => void refreshExport(), POLL_MS);
    return () => clearInterval(id);
  }, [making]);

  const start = async () => {
    setBusy(true);
    setError(null);
    const fail = await startExport();
    setBusy(false);
    if (fail) setError(fail.error);
  };

  let status: string | null = null;
  if (making) status = t('account.export_making');
  else if (job?.status === 'failed') status = job.error ?? t('account.export_failed');
  else if (job && !link && (job.status === 'expired' || job.status === 'ready')) status = t('account.export_expired');

  const row = (key: string, label: string, onPress: () => void, alarm = false) => (
    <Pressable
      key={key}
      testID={`my-data-${key}`}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.row, { minHeight: theme.size.buttonHeight, borderBottomColor: theme.colors.separator, gap: theme.space[3] }]}
    >
      <AppText color={alarm ? 'danger' : 'ink'} style={styles.flex}>
        {label}
      </AppText>
      <ChevronRight size={22} color={alarm ? theme.colors.danger : theme.colors.ink2} />
    </Pressable>
  );

  return (
    <Screen testID="my-data-screen">
      <Button testID="my-data-back" label={t('common.back')} variant="text" minHeight={theme.size.minTouch} onPress={() => router.back()} style={{ alignSelf: 'flex-start' }} />
      <AppText variant="largeTitle" accessibilityRole="header" style={{ marginBottom: theme.space[2] }}>
        {t('account.my_data')}
      </AppText>
      <AppText color="ink2" style={{ marginBottom: theme.space[4] }}>
        {t('account.export_what')}
      </AppText>
      {link && job?.expires_at ? (
        <Button testID="export-share" label={t('account.export_get', { until: untilText(job.expires_at) })} onPress={() => void shareExport()} />
      ) : (
        <Button
          testID="export-start"
          label={making ? t('account.export_making') : t('account.export')}
          disabled={making || busy}
          onPress={() => void start()}
        />
      )}
      {status ? (
        <AppText testID="export-status" accessibilityLiveRegion="polite" style={{ marginTop: theme.space[2] }}>
          {status}
        </AppText>
      ) : null}
      {link ? (
        <AppText variant="callout" style={{ marginTop: theme.space[2] }}>
          {t('account.export_link_hint')}
        </AppText>
      ) : null}
      {error ? (
        <AppText testID="export-error" color="danger" accessibilityLiveRegion="polite" style={{ marginTop: theme.space[2] }}>
          {error}
        </AppText>
      ) : null}

      <AppText variant="sectionLabel" accessibilityRole="header" style={{ marginTop: theme.space[8], marginBottom: theme.space[2] }}>
        {t('account.where_title')}
      </AppText>
      <AppText style={{ marginBottom: theme.space[4] }}>{t('account.where')}</AppText>

      {row('import', t('more.import'), () => router.push('/import'))}
      {row('duplicates', t('more.duplicates'), () => router.push('/duplicates'))}
      {row('trash', t('trash.title'), () => router.push('/trash'))}
      {row('delete', t('account.delete'), () => router.push('/delete-account'), true)}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1 },
  flex: { flex: 1 },
});
