import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Animated, Easing, PanResponder, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ActionNoticeOut } from '@/api/types';
import { actionText, undoAction } from '@/chat/service';
import { getRecords } from '@/db';
import { undoManual } from '@/pages/manual';
import { usePageLabels } from '@/pages/usePageLabels';
import { formatShortDate } from '@/records/format';
import { getRecordActions, kickSync } from '@/services';
import { useAssistant } from '@/store/assistant';
import { useConnectivity } from '@/store/connectivity';
import { useToast } from '@/store/toast';
import { usePages, type Page } from '@/store/pages';
import { undoServerAction } from '@/tasks/actions';
import { NOTICE_MS, useUndo, type ManualStripText, type UndoStripState } from '@/store/undo';
import { askBar, noticeV5, useLayout, useTheme } from '@/theme';
import { useChrome } from '@/store/chrome';

import { AppText } from './AppText';
import { ChangesSheet } from './ChangesSheet';
import { pressedStyle, useReducedMotion } from './ui/motion';
import { useCurrentPage } from './useCurrentPage';
import { useKeyboardHeight } from './useKeyboard';

/** With a screen reader the notice waits longer (2-design 4.3): it cannot be read and pressed in 3 s. */
const SCREEN_READER_MS = 30_000;

/** A notice's words in the app language (`*_kk` is null until reviewed: then Russian). */
const noticeText = (n: ActionNoticeOut, lang: string) => (lang === 'kk' && n.text_kk) || n.text_ru;
const noticeUndo = (n: ActionNoticeOut, lang: string) => (lang === 'kk' && n.undo_label_kk) || n.undo_label_ru;

/**
 * TopNotice (design-system §10.2, Ф-65 / Ф-67 / Ф-75): every reversible result — «Кофе 1 200 ₸ → Расходы», «Удалено:
 * «Шины»», «Вернул как было» — is a small capsule at the **top**, under the status bar: the page square 28, one line
 * of `callout` 600, the button on the right («Отменить» / «Восстановить» / «Вернуть»), a 2 dp bar of the time left.
 * It goes after 3 s (`notice.ms`), a swipe up closes it, a tap on the text opens what changed. The assistant's words
 * come from the server (`action.notice`); the phone's own changes keep their texts. In the chat the result card
 * carries its own «Отменить» instead.
 */
export function UndoStrip() {
  const { t, i18n } = useTranslation();
  const strip = useUndo((s) => s.strip);
  const hide = useUndo((s) => s.hide);
  const current = useCurrentPage();
  const message = useAssistant((s) => (strip?.kind === 'action' ? s.messages.find((m) => m.id === strip.messageId) : undefined));
  const action = message?.action;
  const pages = usePages((s) => s.pages);
  const { title } = usePageLabels();
  const online = useConnectivity((s) => s.online);
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

  // Step 6: a phrase with several actions shows ONE notice, the group's («Сделал 3 дела · Отменить всё»).
  const notice = strip?.kind === 'server' ? (strip.action.notice ?? null) : (action?.group?.notice ?? action?.notice ?? null);
  const durationMs = screenReader ? SCREEN_READER_MS : (notice?.ms ?? NOTICE_MS);

  useEffect(() => {
    if (!strip || changesOpen) return;
    const timer = setTimeout(() => hide(strip.id), durationMs);
    return () => clearTimeout(timer);
  }, [strip, hide, durationMs, changesOpen]);

  if (!strip) return null;
  if (strip.kind === 'action' && !action) return null;
  if (strip.kind === 'action' && current.kind === 'assistant') return null;

  const byServer = (id: string | null | undefined) => (id ? pages.find((p) => p.serverId === id) : undefined);
  const byId = (id: string | null | undefined) => (id ? pages.find((p) => p.id === id) : undefined);
  const page: Page | undefined =
    strip.kind === 'saved'
      ? byId(strip.pageId)
      : strip.kind === 'manual' || strip.kind === 'custom'
        ? byId(strip.openPageId)
        : strip.kind === 'action'
          ? (byServer(notice?.target?.page_id) ?? byServer(action?.savedTo?.[0]?.pageServerId) ?? byServer(action?.pageServerId))
          : strip.kind === 'server'
            ? (byServer(notice?.target?.page_id) ?? byServer(strip.action.page?.id))
            : undefined;

  const text = stripText(strip, { t, lang: i18n.language, title, page, online, action, notice });
  const undoLabel =
    strip.kind === 'action' || strip.kind === 'server'
      ? notice
        ? noticeUndo(notice, i18n.language)
        : strip.kind === 'action' && action?.undoable && !action.undone
          ? t('common.undo')
          : null
      : strip.kind === 'deleted'
        ? t('notice.restore')
        : t('common.undo');

  const undo = () => {
    hide(strip.id);
    setChangesOpen(false);
    useToast.getState().show(t('common.undone'));
    if (strip.kind === 'action') return void undoAction(strip.messageId);
    if (strip.kind === 'server') return void undoServerAction(strip.action.id);
    if (strip.kind === 'manual') return void undoManual(strip.outboxIds);
    if (strip.kind === 'custom') return strip.onUndo();
    if (strip.kind === 'saved') return void getRecordActions().then((a) => a.remove(strip.recordId));
    void getRecordActions().then((a) => (strip.kind === 'merged' ? a.unmerge(strip.recordId) : a.restore(strip.recordId)));
  };

  // A tap on the text opens what changed: the server's `target`, else the page it went to.
  const open = async () => {
    if (strip.kind === 'deleted') return;
    const target = notice?.target;
    if (target?.kind === 'document' && target.id) {
      hide(strip.id);
      return router.navigate({ pathname: '/kp/[id]', params: { id: target.id } });
    }
    if (target?.kind === 'item' && target.id) {
      const rec = await (await getRecords()).findByServerId(target.id);
      if (rec) {
        hide(strip.id);
        return router.navigate({ pathname: '/record/[id]', params: { id: rec.id } });
      }
      kickSync();
    }
    if (strip.kind === 'saved' || strip.kind === 'merged') {
      hide(strip.id);
      return router.navigate({ pathname: '/record/[id]', params: { id: strip.recordId } });
    }
    if (page && page.id !== current.id) {
      hide(strip.id);
      return router.navigate({ pathname: '/page/[id]', params: { id: page.id } });
    }
    if (strip.kind === 'action' && (action?.changes.length ?? 0) > 0) setChangesOpen(true);
  };

  return (
    <>
      <NoticeBar
        key={strip.id}
        text={text}
        page={page}
        deleted={strip.kind === 'deleted'}
        byAssistant={strip.kind === 'action' || strip.kind === 'saved' || (strip.kind === 'server' && strip.action.initiated_by !== 'user')}
        undoLabel={undoLabel}
        durationMs={durationMs}
        onUndo={undo}
        onOpen={() => void open()}
        onClose={() => hide(strip.id)}
      />
      {strip.kind === 'action' && message ? (
        <ChangesSheet message={changesOpen ? message : null} onClose={() => setChangesOpen(false)} onUndoAll={undo} />
      ) : null}
    </>
  );
}

function stripText(
  strip: UndoStripState,
  o: {
    t: (k: string, v?: Record<string, unknown>) => string;
    lang: string;
    title: (p: Page) => string;
    page: Page | undefined;
    online: boolean;
    action: ReturnType<typeof useAssistant.getState>['messages'][number]['action'];
    notice: ActionNoticeOut | null;
  },
): string {
  const { t, lang, title, page, online, action, notice } = o;
  if (strip.kind === 'server') return notice ? noticeText(notice, lang) : (lang === 'kk' && strip.action.summary.kk) || strip.action.summary.ru;
  if (strip.kind === 'action') {
    if (notice) return noticeText(notice, lang);
    const saved = (action?.savedTo?.length ?? 0) > 0 || action?.kind === 'save_item';
    if (saved) {
      const where = page ? title(page) : (action?.savedTo?.[0]?.title ?? null);
      const what = action?.changes[0]?.title ?? '';
      return where ? (what ? t('save.saved_in', { page: where, what }) : t('save.saved_in_plain', { page: where })) : t('save.saved_plain', { what });
    }
    return action ? actionText(action, lang) : '';
  }
  if (strip.kind === 'saved') {
    const base = page ? t('save.saved_in', { page: title(page), what: strip.what }) : t('save.saved_plain', { what: strip.what });
    return online ? base : `${base} ${t('save.offline_tail')}`;
  }
  if (strip.kind === 'merged') return t('dedup.exact', { date: formatShortDate(strip.canonicalDate, lang) });
  if (strip.kind === 'deleted') return strip.what ? t('notice.deleted', { what: strip.what }) : t('record.deleted');
  if (strip.kind === 'manual') return manualText(strip.text, t, title);
  return strip.text;
}

function manualText(m: ManualStripText, t: (k: string, v?: Record<string, unknown>) => string, title: (p: Page) => string): string {
  const names = (m.pages ?? []).map((p) => title(p));
  const base = m.key === 'move.also_done' && names.length > 1 ? t('move.also_done_many', { pages: names.join(', ') }) : t(m.key, { page: names[0] ?? '' });
  return m.extra ? `${base} ${m.extra}` : base;
}

/** The capsule itself (design-system §10.2 `notice`: height 52, radius 22). */
function NoticeBar({
  text,
  page,
  deleted,
  byAssistant,
  undoLabel,
  durationMs,
  onUndo,
  onOpen,
  onClose,
}: {
  text: string;
  page: Page | undefined;
  deleted: boolean;
  /** QA B «Дела» 5: terracotta «Отменить» only for what the assistant did; the person's own action — a link. */
  byAssistant: boolean;
  undoLabel: string | null;
  durationMs: number;
  onUndo: () => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [left] = useState(() => new Animated.Value(1));
  const [drag] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reduced) return;
    const a = Animated.timing(left, { toValue: 0, duration: durationMs, easing: Easing.linear, useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [left, durationMs, reduced]);

  // A swipe up closes it (the bar is mounted anew for every notice, so its `onClose` is the one to keep).
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy < -8 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => drag.setValue(Math.min(0, g.dy)),
      onPanResponderRelease: (_e, g) => {
        if (g.dy < -24) onClose();
        else Animated.spring(drag, { toValue: 0, useNativeDriver: false }).start();
      },
    }),
  );

  const dark = theme.colors.noticeInk;
  // The undo of the assistant is terracotta («Отменить»); the person's own «Восстановить» is an underlined link.
  const actColor = byAssistant ? theme.colors.noticeUndo : dark;
  return (
    <Animated.View
      testID="undo-strip"
      accessibilityLiveRegion="polite"
      {...pan.panHandlers}
      style={[
        styles.bar,
        {
          minHeight: noticeV5.minHeight,
          borderRadius: noticeV5.radius,
          backgroundColor: theme.colors.noticeBg,
          paddingLeft: 16,
          transform: [{ translateY: drag }],
        },
        { shadowColor: '#000000', shadowOffset: { width: 0, height: 14 }, shadowRadius: 30, shadowOpacity: 0.5, elevation: 12 },
      ]}
    >
      <Pressable
        testID="undo-strip-open"
        accessibilityRole="button"
        accessibilityLabel={text}
        accessibilityHint={t('notice.open_hint')}
        onPress={onOpen}
        style={({ pressed }) => [styles.row, styles.grow, { gap: 12, paddingVertical: 8 }, pressedStyle(pressed)]}
      >
        {/* Three dots go out one by one over the 3 s (Ф-67). */}
        <View testID="notice-dots" style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {[2, 1, 0].map((k) => (
            <Animated.View
              key={k}
              style={[
                styles.dotTimer,
                {
                  backgroundColor: dark,
                  opacity: reduced ? 1 : left.interpolate({ inputRange: [k / 3, k / 3 + 0.001], outputRange: [0.25, 1], extrapolate: 'clamp' }),
                },
              ]}
            />
          ))}
        </View>
        <AppText
          testID="undo-strip-text"
          numberOfLines={theme.largeFont ? 3 : noticeV5.maxLines}
          style={[styles.grow, { color: dark, fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 15, lineHeight: 19 }]}
        >
          {text}
        </AppText>
      </Pressable>
      {undoLabel ? (
        <Pressable
          testID="undo-strip-undo"
          accessibilityRole="button"
          accessibilityLabel={undoLabel}
          onPress={onUndo}
          style={({ pressed }) => [styles.button, { minWidth: theme.size.minTouch, minHeight: theme.size.minTouch, paddingHorizontal: 16 }, pressedStyle(pressed)]}
        >
          <AppText style={{ color: actColor, fontFamily: theme.type.title.fontFamily, fontSize: 15, lineHeight: 19, textDecorationLine: byAssistant ? 'none' : 'underline' }}>
            {undoLabel}
          </AppText>
        </Pressable>
      ) : (
        <View style={{ width: 16 }} />
      )}
    </Animated.View>
  );
}

/**
 * Where the notice lies: at the top, 10 from the edges, under the status bar; a result of the assistant line
 * («Записал…») lies 8 above the strip instead while the strip is on screen (Ф-82, design-system §11.12).
 */
export function TopNoticeHost() {
  const layout = useLayout();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const kind = useUndo((s) => s.strip?.kind ?? null);
  const askShown = useChrome((s) => s.askShown);
  const tabBarHeight = useChrome((s) => s.tabBarHeight);
  const keyboard = useKeyboardHeight();
  const current = useCurrentPage();
  const aboveAsk = askShown && current.kind !== 'assistant' && (kind === 'saved' || kind === 'action' || kind === 'server');
  const place = aboveAsk
    ? { bottom: (keyboard > 0 ? keyboard + askBar.aboveKeyboard : tabBarHeight + askBar.aboveTabBar) + theme.m.ask.height + askBar.noticeGap }
    : { top: insets.top + 4 };
  return (
    <View pointerEvents="box-none" style={[styles.host, place, { paddingHorizontal: aboveAsk ? theme.m.ask.inset : noticeV5.inset }]}>
      <View pointerEvents="box-none" style={{ width: '100%', maxWidth: layout.contentMaxWidth }}>
        <UndoStrip />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center' },
  grow: { flex: 1, flexShrink: 1 },
  dots: { flexDirection: 'row', gap: 3 },
  dotTimer: { width: 6, height: 6, borderRadius: 3 },
  button: { alignItems: 'center', justifyContent: 'center' },
});
