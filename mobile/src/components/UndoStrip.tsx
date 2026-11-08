import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { actionText, undoAction } from '@/chat/service';
import { undoManual } from '@/pages/manual';
import { usePageLabels } from '@/pages/usePageLabels';
import { formatShortDate } from '@/records/format';
import { getRecordActions } from '@/services';
import { useAssistant } from '@/store/assistant';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';
import { undoStripMs, useUndo, type ManualStripText } from '@/store/undo';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';
import { ChangesSheet } from './ChangesSheet';
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
  const [changesOpen, setChangesOpen] = useState(false);

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

  const durationMs = undoStripMs({ largeFont: theme.largeFont, screenReader });

  useEffect(() => {
    if (!strip || changesOpen) return;
    const timer = setTimeout(() => hide(strip.id), durationMs);
    return () => clearTimeout(timer);
  }, [strip, hide, durationMs, changesOpen]);

  if (!strip) return null;
  if (strip.kind === 'action' && !action) return null;

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
  const text =
    strip.kind === 'merged'
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
  const showOpen = strip.kind !== 'merged' && strip.kind !== 'deleted' && !!target && target.id !== current.id;
  const canUndo = strip.kind !== 'action' || (!!action?.undoable && !action.undone);
  const hasChanges = strip.kind === 'action' && (action?.changes.length ?? 0) > 0;

  return (
    <View
      testID="undo-strip"
      accessibilityLiveRegion="polite"
      style={[
        styles.box,
        {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.line,
          paddingHorizontal: theme.space[3],
          paddingVertical: theme.space[2],
          gap: theme.space[1],
        },
      ]}
    >
      <View style={[styles.row, { gap: theme.space[2], flexDirection: theme.largeFont ? 'column' : 'row' }]}>
        <AppText testID="undo-strip-text" variant="meta" color="ink" style={theme.largeFont ? undefined : styles.text}>
          {text}
        </AppText>
        <View style={[styles.row, { gap: theme.space[1], flexWrap: 'wrap' }]}>
          {showOpen && target ? (
            <Button
              testID="undo-strip-open"
              label={t('line.open')}
              accessibilityLabel={t('move.open_a11y', { page: title(target) })}
              variant="text"
              minHeight={theme.size.minTouch}
              onPress={() => router.navigate({ pathname: '/page/[id]', params: { id: target.id } })}
            />
          ) : null}
          {hasChanges ? (
            <Button
              testID="undo-strip-changes"
              label={t('line.changed')}
              variant="text"
              minHeight={theme.size.minTouch}
              onPress={() => setChangesOpen(true)}
            />
          ) : null}
          {canUndo ? (
            <Button
              testID="undo-strip-undo"
              label={t('common.undo')}
              variant="text"
              minHeight={theme.size.minTouch}
              onPress={undo}
            />
          ) : null}
        </View>
      </View>
      {strip.kind === 'action' && message ? (
        <ChangesSheet message={changesOpen ? message : null} onClose={() => setChangesOpen(false)} onUndoAll={undo} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderTopWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1 },
});
