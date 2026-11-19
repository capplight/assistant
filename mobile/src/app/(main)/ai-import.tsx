import { router } from 'expo-router';
import { FileUp } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import type { ImportOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { ProgressPlate, StepList } from '@/components/ui/Steps';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { CompactConfirm } from '@/components/ui/Floating';
import { BigNumber, ChipRow } from '@/components/ui/Leaf';
import { Card } from '@/components/ui/Card';
import { Header } from '@/components/ui/Header';
import { Icon } from '@/components/ui/Icon';
import { pickExportFile } from '@/dedup/pickFile';
import {
  AI_IMPORT_MAX_BYTES,
  cancelImport,
  importRunning,
  isAiExportFile,
  pollImport,
  startAiImport,
  undoImport,
} from '@/dedup/service';
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
const ERRORS = new Set([
  'import_bad_file',
  'import_no_chats_file',
  'import_unknown_format',
  'import_too_large',
  'import_file_missing',
  'import_not_chats_file',
  'import_running',
]);

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
  const [askUndo, setAskUndo] = useState(false);
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
        <Button
          testID="aiimp-again"
          label={t('import.again')}
          variant="secondary"
          onPress={() => useDedup.getState().set({ aiImportRow: null })}
        />
      </Card>
    );
  } else if (imp && running) {
    status = (
      <ProgressPlate
        testID="aiimp-progress"
        barTestID="aiimp-bar"
        title={imp.total > 0 ? t('aiimp.reading_name', { name: name ?? t('aiimp.chats') }) : t('import.reading')}
        share={imp.total > 0 ? imp.processed / imp.total : null}
        count={imp.total > 0 ? t('aiimp.count', { done: imp.processed, total: imp.total }) : null}
        note={t('import.can_close')}
        stopLabel={t('import.stop')}
        stopTestID="aiimp-stop"
        onStop={() => void cancelImport(imp.id)}
      />
    );
  } else if (imp) {
    status = (
      // screens-v5-extra «Переписки · готово»: how many — the one big number; what was found — one line.
      <View testID="aiimp-done" style={{ gap: theme.space[2] }}>
        <BigNumber value={String(imp.conversations ?? imp.created_count ?? 0)} />
        <AppText variant="small">{t('aiimp.done_title')}</AppText>
        <AppText testID="aiimp-summary">
          {imp.summary_ru ?? t('aiimp.done', { count: imp.conversations ?? imp.created_count, name: name ?? '' })}
        </AppText>
        <View style={[styles.row, { gap: theme.space[2], flexWrap: 'wrap' }]}>
          <Button
            testID="aiimp-open"
            label={t('aiimp.open_chats')}
            size="small"
            onPress={() => router.navigate('/ai-chats')}
          />
          {imp.action_id ? (
            // screens-v5-extra «Переписки · готово»: «Удалить импорт» asks once, compactly (the chats go to the trash).
            <Button
              testID="aiimp-undo"
              label={t('aiimp.undo')}
              variant="link"
              size="small"
              onPress={() => setAskUndo(true)}
            />
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <Screen testID="page-ai-import" mode="strip">
      <Header
        title={t('aiimp.title')}
        meta={t('aiimp.meta')}
        back={{
          onPress: () => (router.canGoBack() ? router.back() : router.replace('/more')),
          label: t('more.title'),
          testID: 'aiimp-back',
        }}
      />
      <View style={{ gap: theme.space[4] }}>
        <ChipRow>
          {PROVIDERS.map((p) => (
            <Chip
              key={p}
              testID={`aiimp-provider-${p}`}
              label={NAMES[p] ?? p}
              variant={provider === p ? 'selected' : 'neutral'}
              accessibilityLabel={`${NAMES[p]}. ${t(`aiimp.file_${p}`)}`}
              onPress={() => setProvider(p)}
            />
          ))}
        </ChipRow>

        {/* screens-v5-extra «Переписки · принести архив»: the source a chip, the steps in circles under it. */}
        <View testID="aiimp-how" accessibilityLabel={t('aiimp.how', { name: NAMES[provider] })}>
          <AppText style={styles.srOnly}>{t('aiimp.how', { name: NAMES[provider] })}</AppText>
          <StepList
            testID="aiimp-steps"
            steps={[1, 2, 3].map((n) => ({
              text: t(`aiimp.${provider}_step${n}`),
              hint: t(`aiimp.${provider}_step${n}_hint`),
            }))}
          />
        </View>

        {status}

        {!row || row.error || (imp && !running) ? (
          <Button
            testID="aiimp-pick"
            label={t('aiimp.pick')}
            icon={<Icon icon={FileUp} size="sm" color="onBrand" />}
            disabled={busy}
            onPress={() => void pick()}
          />
        ) : null}
        <AppText variant="footnote" color="ink2">
          {t('aiimp.private')}
        </AppText>
        <Button
          testID="aiimp-telegram"
          label={t('aiimp.telegram')}
          variant="text"
          onPress={() => router.push('/import')}
        />
      </View>
      <CompactConfirm
        visible={askUndo && !!imp}
        title={t('aiimp.undo_confirm_title')}
        body={t('aiimp.undo_confirm_body')}
        cancelLabel={t('aiimp.undo_keep')}
        confirmLabel={t('aiimp.undo')}
        onCancel={() => setAskUndo(false)}
        onConfirm={() => {
          setAskUndo(false);
          if (imp) void undoImport(imp);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  srOnly: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  tile: { gap: 2, minHeight: 72 },
  num: { minWidth: 24, minHeight: 24, alignItems: 'center', justifyContent: 'center' },
});
