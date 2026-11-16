import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { actionText, undoAction } from '@/chat/service';
import { undoManual } from '@/pages/manual';
import { usePageLabels } from '@/pages/usePageLabels';
import { formatShortDate } from '@/records/format';
import { getRecords, type LocalRecord } from '@/db';
import { placesLocally } from '@/pages/contents';
import { getRecordActions, kickSync } from '@/services';
import { useAssistant } from '@/store/assistant';
import { usePages, type Page } from '@/store/pages';
import { useConnectivity } from '@/store/connectivity';
import { useToast } from '@/store/toast';
import { SAVE_TOAST_MS, undoStripMs, useUndo, type ManualStripText } from '@/store/undo';
import { useTheme } from '@/theme';

import { ChangesSheet } from './ChangesSheet';
import { ReplaceSheet } from './ReplaceSheet';
import { ToastBar, type ToastAction } from './ui/ToastBar';
import { useCurrentPage } from './useCurrentPage';

/**
 * «Уже было — добавил к записи от 12 мар · Отменить», «Удалил запись · Отменить», and the result
 * of an assistant action «Разложил 23 заметки в 5 групп [Что изменилось] [Отменить]» (2-design
 * 4.3 «Итог действия»): lives with the assistant line, in one frame with it. Stays longer with a
 * large font or a screen reader (2-design 4.3), and while «Что изменилось» is open. An action on
 * another page says so and offers [Открыть] (R-53).
 * Not done: «не исчезает, пока на ней фокус», React Native does not report screen reader focus.
 */
export function UndoStrip() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const strip = useUndo((s) => s.strip);
  const hide = useUndo((s) => s.hide);
  const showToast = useToast((s) => s.show);
  const current = useCurrentPage();
  const message = useAssistant((s) =>
    strip?.kind === 'action' ? s.messages.find((m) => m.id === strip.messageId) : undefined,
  );
  const action = message?.action;
  const otherPage = usePages((s) =>
    action?.pageServerId ? s.pages.find((p) => p.serverId === action.pageServerId) : undefined,
  );
  const { title } = usePageLabels();
  const openTarget = usePages((s) =>
    (strip?.kind === 'manual' || strip?.kind === 'custom') && strip.openPageId
      ? s.pages.find((p) => p.id === strip.openPageId)
      : undefined,
  );
  const [screenReader, setScreenReader] = useState(false);
  const online = useConnectivity((s) => s.online);
  const [changesOpen, setChangesOpen] = useState(false);
  const [replace, setReplace] = useState<{ record: LocalRecord; what: string; from: Page | null } | null>(null);
  const savePage = usePages((s) =>
    strip?.kind === 'saved' ? (strip.pageId ? s.pages.find((p) => p.id === strip.pageId) : undefined) : undefined,
  );

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((on) => {
        if (alive) setScreenReader(on);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const isSave = strip?.kind === 'saved' || (strip?.kind === 'action' && ((action?.savedTo?.length ?? 0) > 0 || action?.kind === 'save_item'));
  const savedToPage = usePages((s) => {
    const to = action?.savedTo?.[0];
    return to ? s.pages.find((p) => p.serverId === to.pageServerId) : undefined;
  });
  const durationMs = isSave && !theme.largeFont && !screenReader ? SAVE_TOAST_MS : undoStripMs({ largeFont: theme.largeFont, screenReader });

  useEffect(() => {
    if (!strip || changesOpen || replace) return;
    const timer = setTimeout(() => hide(strip.id), durationMs);
    return () => clearTimeout(timer);
  }, [strip, hide, durationMs, changesOpen, replace]);

  const replaceSheet = replace ? (
    <ReplaceSheet record={replace.record} what={replace.what} from={replace.from} onClose={() => setReplace(null)} />
  ) : null;
  if (!strip) return replaceSheet;
  if (strip.kind === 'action' && !action) return null;
  // In the chat the result card carries «Переложить · Отменить» itself (v4 «Сделал 3 дела»).
  if (strip.kind === 'action' && current.kind === 'assistant') return replaceSheet;

  const undo = () => {
    hide(strip.id);
    setChangesOpen(false);
    showToast(t('common.undone'));
    if (strip.kind === 'action') {
      void undoAction(strip.messageId);
      return;
    }
    if (strip.kind === 'manual') {
      void undoManual(strip.outboxIds);
      return;
    }
    if (strip.kind === 'custom') {
      strip.onUndo();
      return;
    }
    if (strip.kind === 'saved') {
      void getRecordActions().then((a) => a.remove(strip.recordId));
      return;
    }
    void getRecordActions().then((a) =>
      strip.kind === 'merged' ? a.unmerge(strip.recordId) : a.restore(strip.recordId),
    );
  };

  const manualText = (m: ManualStripText) => {
    const names = (m.pages ?? []).map((p) => title(p));
    const base =
      m.key === 'move.also_done' && names.length > 1
        ? t('move.also_done_many', { pages: names.join(', ') })
        : t(m.key, { page: names[0] ?? '' });
    return m.extra ? `${base} ${m.extra}` : base;
  };
  // «Сохранил в «Заметки»: код домофона» (Ф-50): the page the record went to, from the server's action or this phone.
  const saveFrom = strip.kind === 'saved' ? (savePage ?? null) : strip.kind === 'action' ? (savedToPage ?? otherPage ?? null) : null;
  const savedToTitle = strip.kind === 'action' ? (action?.savedTo?.[0]?.title ?? null) : null;
  const saveWhat = strip.kind === 'saved' ? strip.what : (action?.changes[0]?.title ?? '');
  const savePageName = saveFrom ? title(saveFrom) : savedToTitle;
  const savedText = savePageName
    ? saveWhat
      ? t('save.saved_in', { page: savePageName, what: saveWhat })
      : t('save.saved_in_plain', { page: savePageName })
    : t('save.saved_plain', { what: saveWhat });
  // Honest about the connection (week 4): a note kept on this phone says it goes when there is a connection.
  const text = isSave
    ? strip.kind === 'saved' && !online
      ? `${savedText} ${t('save.offline_tail')}`
      : savedText
    : strip.kind === 'merged'
      ? t('dedup.exact', { date: formatShortDate(strip.canonicalDate, i18n.language) })
      : strip.kind === 'deleted'
        ? t('record.deleted')
        : strip.kind === 'manual'
          ? manualText(strip.text)
          : strip.kind === 'custom'
            ? strip.text
          : action
            ? actionText(action, i18n.language)
            : '';
  const target = strip.kind === 'manual' || strip.kind === 'custom' ? openTarget : otherPage;
  const showOpen = !isSave && strip.kind !== 'merged' && strip.kind !== 'deleted' && !!target && target.id !== current.id;
  const canUndo = strip.kind !== 'action' || (!!action?.undoable && !action.undone);
  const hasChanges = !isSave && strip.kind === 'action' && (action?.changes.length ?? 0) > 0;

  const openReplace = async () => {
    const repo = await getRecords();
    let record: LocalRecord | null = null;
    if (strip.kind === 'saved') record = await repo.get(strip.recordId);
    else if (action) {
      const serverId = action.savedTo?.[0]?.itemIds[0] ?? action.changedItemIds[0] ?? action.changes[0]?.itemId ?? null;
      if (serverId) {
        record = await repo.findByServerId(serverId);
        if (!record) {
          // The record comes with /sync: ask for it once and look again.
          kickSync();
          await new Promise((r) => setTimeout(r, 1500));
          record = await repo.findByServerId(serverId);
        }
      }
    }
    if (!record) {
      showToast(t('save.replace_later'), 4000);
      return;
    }
    const pages = usePages.getState().pages;
    const from = saveFrom ?? pages.find((p) => placesLocally(p, record)) ?? null;
    hide(strip.id);
    setReplace({ record, what: saveWhat || title(from ?? pages[0]!), from });
  };

  const actions: ToastAction[] = [];
  if (isSave) actions.push({ key: 'replace', testID: 'undo-strip-replace', label: t('save.replace'), onPress: () => void openReplace() });
  if (showOpen && target)
    actions.push({
      key: 'open',
      testID: 'undo-strip-open',
      label: t('line.open'),
      accessibilityLabel: t('move.open_a11y', { page: title(target) }),
      onPress: () => router.navigate({ pathname: '/page/[id]', params: { id: target.id } }),
    });
  if (hasChanges) actions.push({ key: 'changes', testID: 'undo-strip-changes', label: t('line.changed'), onPress: () => setChangesOpen(true) });
  if (canUndo) actions.push({ key: 'undo', testID: 'undo-strip-undo', label: t('common.undo'), onPress: undo });

  return (
    <>
      <ToastBar
        testID="undo-strip"
        textTestID="undo-strip-text"
        text={text}
        success={strip.kind !== 'deleted'}
        actions={actions}
        onClose={() => hide(strip.id)}
      />
      {replaceSheet}
      {strip.kind === 'action' && message ? (
        <ChangesSheet message={changesOpen ? message : null} onClose={() => setChangesOpen(false)} onUndoAll={undo} />
      ) : null}
    </>
  );
}


/**
 * The strip on a screen outside the main area (S20 «Что я сделал», S30 «Что я для вас настроил»,
 * S38): the same «Отменить» at the same bottom edge, over the safe area.
 */
export function StandaloneUndoStrip() {
  const theme = useTheme();
  return (
    <SafeAreaView edges={['bottom']} style={{ paddingHorizontal: theme.size.tabBarInset, paddingVertical: theme.space[2] }}>
      <UndoStrip />
    </SafeAreaView>
  );
}
