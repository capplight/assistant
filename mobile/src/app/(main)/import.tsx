import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import { cleanupPreview } from '@/api/endpoints';
import { ApiError } from '@/api/errors';
import type { ConsentTextOut, ImportOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import {
  cancelImport,
  confirmCleanup,
  giveImportConsent,
  importConsentText,
  importRunning,
  isExportFile,
  liveCleanup,
  planCleanup,
  pollImport,
  rejectCleanup,
  startImport,
  undoImport,
} from '@/dedup/service';
import { pickExportFile } from '@/dedup/pickFile';
import { useDedup } from '@/dedup/store';
import { syncBlocked } from '@/services';
import { useConnectivity } from '@/store/connectivity';
import { useOnboarding } from '@/store/onboarding';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

/** While an import runs and this screen is open: ask how far it got. */
export const IMPORT_POLL_MS = 2_000;

/** import.md error codes → the line shown. */
const ERRORS: Record<string, string> = {
  import_bad_file: 'not_telegram_export',
  import_no_result_json: 'not_telegram_export',
  import_not_saved_messages: 'not_saved_messages',
  import_too_many: 'too_many',
  import_too_large: 'file_too_big',
  import_running: 'running',
  consent_required: 'consent_required',
  import_file_missing: 'generic',
};

const MEDIA_KEYS = new Set(['video', 'photo', 'sticker', 'voice', 'audio', 'file']);

/**
 * S21 «Принести заметки» (2-design S21, 3-engineering 6.10, R-28): the Telegram Desktop export
 * file (`result.json` or a zip). How to make it, then «Выбрать файл» → the `telegram_import`
 * consent once (its server text, exactly as shown) → the file goes the same way as any file
 * (outbox: upload, then POST /imports/telegram/file; the pages are chosen by their rules), so a lost connection or a restart does not
 * lose it. Progress «Переношу… 120 из 1 200» with [Остановить]; the summary says what came over,
 * what was there already (never twice), what was not brought (media without text) and offers the
 * cleanup of repeats as ONE «Да». The import itself has «Отменить перенос».
 * Not here (Full, weeks 24–25): «Войти в Telegram», «Переслать боту».
 */
export default function ImportScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const online = useConnectivity((s) => s.online);
  const { row, imports, cleanup } = useDedup(useShallow((s) => ({ row: s.importRow, imports: s.imports, cleanup: s.cleanup })));
  const imp: ImportOut | null = row?.importId ? (imports[row.importId] ?? null) : null;
  const [consent, setConsent] = useState<ConsentTextOut | null>(null);
  const [busy, setBusy] = useState(false);
  const planned = useRef<string | null>(null);
  const running = importRunning(imp);

  // Progress: GET /imports/{id} while it runs and the screen is open.
  useEffect(() => {
    if (!imp || !running) return;
    const id = imp.id;
    const timer = setInterval(() => void pollImport(id), IMPORT_POLL_MS);
    return () => clearInterval(timer);
  }, [imp, running]);

  // Done: the plan «Повторов: 214 — убрать?» (nothing changes until «Да»).
  useEffect(() => {
    if (!imp || imp.status !== 'done' || imp.cleanup || planned.current === imp.id) return;
    planned.current = imp.id;
    void planCleanup(imp.id);
  }, [imp]);

  const pick = async () => {
    if (useOnboarding.getState().consent === null || syncBlocked()) {
      showToast(t('import.offline'), 4000);
      return;
    }
    setBusy(true);
    try {
      const text = await importConsentText();
      if (text) {
        setConsent(text);
        return;
      }
      await chooseFile();
    } catch (e) {
      showToast(e instanceof ApiError && e.status === 404 ? t('import.consent_unavailable') : t('import.offline'), 4000);
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async () => {
    const f = await pickExportFile();
    if (!f) return;
    if (!isExportFile(f.name)) {
      showToast(t('import.wrong_file'), 5000);
      return;
    }
    await startImport({ uri: f.uri, name: f.name, mime: f.mime });
  };

  const agree = async () => {
    const text = consent;
    setConsent(null);
    if (!text) return;
    setBusy(true);
    try {
      await giveImportConsent(text);
      await chooseFile();
    } catch {
      showToast(t('import.offline'), 4000);
    } finally {
      setBusy(false);
    }
  };

  const errorText = (code: string | null) => t(`import.err_${code && ERRORS[code] ? ERRORS[code] : 'generic'}`);

  const card = { borderColor: theme.colors.line, backgroundColor: theme.colors.surface, borderRadius: theme.radius.card, padding: theme.space[4], gap: theme.space[2] };

  let body: React.ReactNode;
  if (row && !row.importId && !row.error) {
    body = (
      <View testID="import-sending" style={[styles.card, card]} accessibilityLiveRegion="polite">
        <AppText>{row.fileName}</AppText>
        <AppText>{online ? t('import.sending') : t('import.waiting')}</AppText>
      </View>
    );
  } else if (row?.error || imp?.status === 'failed') {
    body = (
      <View testID="import-failed" style={[styles.card, card]} accessibilityLiveRegion="polite">
        <AppText variant="title2">{t('import.failed')}</AppText>
        <AppText>{errorText(row?.error ?? imp?.error ?? null)}</AppText>
        <Button testID="import-again" label={t('import.again')} variant="outline" onPress={() => useDedup.getState().set({ importRow: null })} />
      </View>
    );
  } else if (imp && running) {
    body = (
      <View testID="import-progress" style={[styles.card, card]} accessibilityLiveRegion="polite">
        <AppText variant="title2">
          {imp.total > 0 ? t('import.progress', { done: imp.processed, total: imp.total }) : t('import.reading')}
        </AppText>
        <Button testID="import-stop" label={t('import.stop')} variant="outline" onPress={() => void cancelImport(imp.id)} />
      </View>
    );
  } else if (imp) {
    body = <Summary imp={imp} cleanupLive={!!liveCleanup(cleanup)} />;
  } else {
    body = (
      <View style={{ gap: theme.space[4] }}>
        <View testID="import-tg" style={[styles.card, card]}>
          <AppText variant="title2">{t('import.file_title')}</AppText>
          <AppText>{t('import.file_hint')}</AppText>
          <AppText variant="section" accessibilityRole="header" style={{ marginTop: theme.space[2] }}>
            {t('import.how')}
          </AppText>
          {[1, 2, 3, 4, 5].map((n) => (
            <AppText key={n}>{`${n}. ${t(`import.step${n}`)}`}</AppText>
          ))}
        </View>
        <Button testID="import-pick" label={t('import.pick')} disabled={busy} onPress={() => void pick()} />
        <AppText variant="meta">{t('import.again_hint')}</AppText>
      </View>
    );
  }

  return (
    <Screen testID="page-import" edges={['top']}>
      <View style={[styles.row, { marginBottom: theme.space[4] }]}>
        <Button
          testID="import-back"
          label={`‹ ${t('common.back')}`}
          variant="text"
          minHeight={theme.size.minTouch}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
        <AppText variant="title1" accessibilityRole="header" style={styles.flex}>
          {t('import.title')}
        </AppText>
      </View>
      <AppText variant="section" accessibilityRole="header" style={{ marginBottom: theme.space[2] }}>
        {t('import.tg_section')}
      </AppText>
      {body}
      <Modal visible={!!consent} transparent animationType="slide" onRequestClose={() => setConsent(null)}>
        <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
          <SafeAreaView
            edges={['bottom']}
            testID="import-consent"
            style={{ backgroundColor: theme.colors.surface, borderTopLeftRadius: theme.radius.sheet, borderTopRightRadius: theme.radius.sheet, maxHeight: '90%' }}
          >
            <ScrollView contentContainerStyle={{ padding: theme.space[5], gap: theme.space[3] }}>
              <AppText variant="title2" accessibilityRole="header">
                {t('import.consent_title')}
              </AppText>
              <AppText testID="import-consent-text">{consent?.text ?? ''}</AppText>
              {/* Both answers equally visible: consent must be free. */}
              <Button testID="import-consent-yes" label={t('import.consent_yes')} onPress={() => void agree()} />
              <Button testID="import-consent-no" label={t('import.consent_no')} variant="outline" onPress={() => setConsent(null)} />
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </Screen>
  );
}

/** «Перенёс 1 200 заметок. Разложил в 9 стопок. Повторов: 214 — убрать?» «Видео (34) не перенёс — только подписи». */
function Summary({ imp, cleanupLive }: { imp: ImportOut; cleanupLive: boolean }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const cleanup = useDedup((s) => s.cleanup);
  const preview = cleanupLive ? cleanupPreview(cleanup) : null;
  const media = Object.entries(imp.skipped_media);
  const card = { borderColor: theme.colors.line, backgroundColor: theme.colors.surface, borderRadius: theme.radius.card, padding: theme.space[4], gap: theme.space[2] };
  return (
    <View style={{ gap: theme.space[4] }}>
      <View testID="import-summary" style={[styles.card, card]} accessibilityLiveRegion="polite">
        <AppText variant="title2" accessibilityRole="header">
          {imp.status === 'cancelled' ? t('import.stopped_title') : t('import.done_title')}
        </AppText>
        <AppText testID="import-created">{t('import.created', { count: imp.created_count })}</AppText>
        {imp.stacks > 0 ? <AppText testID="import-stacks">{t('import.stacks', { count: imp.stacks })}</AppText> : null}
        {imp.seen_before + imp.skipped_dups > 0 ? (
          <AppText testID="import-seen">{t('import.seen', { count: imp.seen_before + imp.skipped_dups })}</AppText>
        ) : null}
        {media.map(([k, n]) => (
          <AppText key={k} testID={`import-media-${k}`}>
            {t('import.media', { what: t(`import.media_${MEDIA_KEYS.has(k) ? k : 'other'}`), count: n })}
          </AppText>
        ))}
        {imp.failed > 0 ? <AppText>{t('import.failed_rows', { count: imp.failed })}</AppText> : null}
        {imp.status === 'cancelled' ? <AppText>{t('import.stopped')}</AppText> : null}
      </View>
      {preview ? (
        <View testID="import-cleanup" style={[styles.card, card]}>
          <AppText variant="title2">{t('import.cleanup', { count: preview.removed })}</AppText>
          <AppText>{t('dup.batch_detail', { removed: preview.removed, after: preview.after })}</AppText>
          <Button testID="import-cleanup-yes" label={t('dup.batch_yes')} onPress={() => void confirmCleanup()} />
          <Button testID="import-cleanup-no" label={t('common.not_now')} variant="outline" onPress={() => void rejectCleanup()} />
        </View>
      ) : null}
      {imp.similar_groups > 0 ? (
        <View style={[styles.card, card]}>
          <AppText>{t('import.similar', { count: imp.similar_groups })}</AppText>
          <Button testID="import-similar" label={t('dup.look')} accessibilityLabel={t('dup.look_a11y')} variant="outline" onPress={() => router.push('/duplicates')} />
        </View>
      ) : null}
      {imp.action_id ? (
        <Button testID="import-undo" label={t('import.undo_import')} variant="text" onPress={() => void undoImport(imp)} />
      ) : null}
      <Button testID="import-again" label={t('import.again')} variant="outline" onPress={() => useDedup.getState().set({ importRow: null })} />
      <AppText variant="meta">{t('import.again_hint')}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  card: { borderWidth: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
