import { router } from 'expo-router';
import { FileUp } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import type { ImportOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { ProgressBar } from '@/components/ui/Brief';
import { Button } from '@/components/ui/Button';
import { Card, cardEdge } from '@/components/ui/Card';
import { Header } from '@/components/ui/Header';
import { Icon } from '@/components/ui/Icon';
import { pressedStyle } from '@/components/ui/motion';
import { pickExportFile } from '@/dedup/pickFile';
import { AI_IMPORT_MAX_BYTES, cancelImport, importRunning, isAiExportFile, pollImport, startAiImport, undoImport } from '@/dedup/service';
import { useDedup } from '@/dedup/store';
import { syncBlocked } from '@/services';
import { useConnectivity } from '@/store/connectivity';
import { useOnboarding } from '@/store/onboarding';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

/** While it runs and this screen is open: ask how far it got (import.md: every 2–3 s). */
const IMPORT_POLL_MS = 2_000;

type Provider = 'chatgpt' | 'claude' | 'gemini';
const PROVIDERS: Provider[] = ['chatgpt', 'claude', 'gemini'];
const NAMES: Record<string, string> = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };

/** import.md step 7 error codes → the line shown. */
const ERRORS = new Set(['import_bad_file', 'import_no_chats_file', 'import_unknown_format', 'import_too_large', 'import_file_missing', 'import_not_chats_file', 'import_running']);

/**
 * «Принести переписку» (v4, design-system §10.7, import.md step 7): the person's own chats with ChatGPT, Claude or
 * Gemini from the provider's export file — so «что мне советовали про кафе в Стамбуле?» is found here. Three tiles
 * pick whose how-to to show (the server recognises the file anyway); «Выбрать файл» → the outbox uploads it and starts
 * the import; progress «Разбираю ChatGPT · 312 разговоров» with «можно закрыть, продолжу сам»; the server's summary and
 * «Удалить импорт» (the import's action undone: the chats go to «Удалённые записи»). The chats live in «Чаты ИИ» (Ф-77).
 */
export default function AiImportScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const online = useConnectivity((s) => s.online);
  const { row, imports } = useDedup(useShallow((s) => ({ row: s.aiImportRow, imports: s.imports })));
  const imp: ImportOut | null = row?.importId ? (imports[row.importId] ?? null) : null;
  const [provider, setProvider] = useState<Provider>('chatgpt');
  const [busy, setBusy] = useState(false);
  const running = importRunning(imp);

  useEffect(() => {
    if (!imp || !running) return;
    const id = imp.id;
    const timer = setInterval(() => void pollImport(id), IMPORT_POLL_MS);
    return () => clearInterval(timer);
  }, [imp, running]);

  const pick = async () => {
    if (useOnboarding.getState().consent === null || syncBlocked()) {
      showToast(t('import.offline'), 4000);
      return;
    }
    setBusy(true);
    try {
      const f = await pickExportFile();
      if (!f) return;
      if (!isAiExportFile(f.name)) {
        showToast(t('aiimp.wrong_file'), 5000);
        return;
      }
      // A ChatGPT zip with many pictures can be over 50 MB: its `conversations.json` alone is enough.
      if (f.size !== null && f.size > AI_IMPORT_MAX_BYTES) {
        showToast(/\.zip$/i.test(f.name) ? t('aiimp.too_big_zip') : t('aiimp.too_big'), 8000);
        return;
      }
      await startAiImport({ uri: f.uri, name: f.name, mime: f.mime });
    } finally {
      setBusy(false);
    }
  };

  const errorText = (code: string | null) => t(code && ERRORS.has(code) ? `aiimp.err_${code}` : 'import.err_generic');
  const name = imp?.provider ? (NAMES[imp.provider] ?? imp.provider) : null;
  const percent = imp && imp.total > 0 ? Math.round((imp.processed / imp.total) * 100) : 0;

  let status: React.ReactNode = null;
  if (row && !row.importId && !row.error) {
    status = (
      <Card testID="aiimp-sending">
        <AppText variant="headline">{row.fileName}</AppText>
        <AppText variant="callout">{online ? t('import.sending') : t('import.waiting')}</AppText>
      </Card>
    );
  } else if (row?.error || imp?.status === 'failed') {
    status = (
      <Card testID="aiimp-failed">
        <AppText variant="headline">{t('import.failed')}</AppText>
        <AppText testID="aiimp-error">{errorText(row?.error ?? imp?.error ?? null)}</AppText>
        <Button testID="aiimp-again" label={t('import.again')} variant="secondary" onPress={() => useDedup.getState().set({ aiImportRow: null })} />
      </Card>
    );
  } else if (imp && running) {
    status = (
      <Card testID="aiimp-progress">
        <AppText variant="headline" accessibilityLiveRegion="polite">
          {imp.total > 0
            ? t('aiimp.progress', { name: name ?? t('aiimp.chats'), done: imp.processed, total: imp.total })
            : t('import.reading')}
        </AppText>
        {imp.total > 0 ? <ProgressBar testID="aiimp-bar" value={imp.processed / imp.total} color={theme.colors.brand} /> : null}
        <AppText variant="footnote">{t('aiimp.can_close', { percent })}</AppText>
        <Button testID="aiimp-stop" label={t('import.stop')} variant="text" onPress={() => void cancelImport(imp.id)} />
      </Card>
    );
  } else if (imp) {
    status = (
      <Card testID="aiimp-done">
        <AppText variant="headline">{t('aiimp.done_title')}</AppText>
        <AppText testID="aiimp-summary">{imp.summary_ru ?? t('aiimp.done', { count: imp.conversations ?? imp.created_count, name: name ?? '' })}</AppText>
        <View style={[styles.row, { gap: theme.space[2], flexWrap: 'wrap' }]}>
          <Button testID="aiimp-open" label={t('aiimp.open_chats')} size="small" onPress={() => router.navigate('/ai-chats')} />
          {imp.action_id ? (
            <Button testID="aiimp-undo" label={t('aiimp.undo')} variant="text" labelColor="danger" onPress={() => void undoImport(imp)} />
          ) : null}
        </View>
      </Card>
    );
  }

  return (
    <Screen testID="page-ai-import" edges={['top']}>
      <Header title={t('aiimp.title')} meta={t('aiimp.meta')} back={{ onPress: () => (router.canGoBack() ? router.back() : router.replace('/more')), label: t('more.title'), testID: 'aiimp-back' }} />
      <View style={{ gap: theme.space[4] }}>
        {/* One row of three; at a large font one under another (each tile whole). */}
        <View accessibilityRole="radiogroup" style={[theme.largeFont ? null : styles.row, { gap: theme.space[2] }]}>
          {PROVIDERS.map((p) => {
            const on = provider === p;
            return (
              <Pressable
                key={p}
                testID={`aiimp-provider-${p}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                onPress={() => setProvider(p)}
                style={({ pressed }) => [
                  styles.tile,
                  theme.largeFont ? null : styles.flex,
                  {
                    backgroundColor: on ? theme.colors.brandTint : theme.colors.surface,
                    borderRadius: theme.radius.xl,
                    padding: theme.space[3],
                    borderWidth: on ? 2 : 0,
                    borderColor: theme.colors.brand,
                  },
                  on ? null : [theme.elevation.card, cardEdge(theme)],
                  pressedStyle(pressed),
                ]}
              >
                <AppText variant="headline">{NAMES[p]}</AppText>
                <AppText variant="footnote">{t(`aiimp.file_${p}`)}</AppText>
              </Pressable>
            );
          })}
        </View>

        <Card testID="aiimp-how">
          <AppText variant="sectionLabel" accessibilityRole="header">
            {t('aiimp.how', { name: NAMES[provider] })}
          </AppText>
          {[1, 2, 3].map((n) => (
            <View key={n} style={[styles.row, { gap: theme.space[3], alignItems: 'flex-start' }]}>
              <View style={[styles.num, { backgroundColor: theme.colors.brandTint, borderRadius: 12 }]}>
                <AppText variant="caption" color="brand">
                  {n}
                </AppText>
              </View>
              <View style={styles.flex}>
                <AppText>{t(`aiimp.${provider}_step${n}`)}</AppText>
                <AppText variant="footnote">{t(`aiimp.${provider}_step${n}_hint`)}</AppText>
              </View>
            </View>
          ))}
        </Card>

        {status}

        {!row || row.error || (imp && !running) ? (
          <Button testID="aiimp-pick" label={t('aiimp.pick')} icon={<Icon icon={FileUp} size="sm" color="onBrand" />} disabled={busy} onPress={() => void pick()} />
        ) : null}
        <AppText variant="footnote" color="ink2">
          {t('aiimp.private')}
        </AppText>
        <Button testID="aiimp-telegram" label={t('aiimp.telegram')} variant="text" onPress={() => router.push('/import')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  tile: { gap: 2, minHeight: 72 },
  num: { minWidth: 24, minHeight: 24, alignItems: 'center', justifyContent: 'center' },
});
