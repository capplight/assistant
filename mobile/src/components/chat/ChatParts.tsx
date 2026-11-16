import { router } from 'expo-router';
import { AiLabel } from '@/components/AiLabel';
import { Check, ChevronRight, Clock, CloudOff, FileUp, Map as MapIcon, MessageCircleMore, Search, StickyNote, Undo2 } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { actionText, answerProposal, undoAction } from '@/chat/service';
import { getRecords, type LocalRecord } from '@/db';
import { usePageLabels } from '@/pages/usePageLabels';
import { kickSync } from '@/services';
import type { ChatAction, ChatMessage } from '@/store/assistant';
import { usePages, type Page } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useView } from '@/store/view';
import { useTheme, withAlpha } from '@/theme';

import { AppText } from '../AppText';
import { answerNotice, useLocalHitTitles } from '../answerText';
import { ReplaceSheet } from '../ReplaceSheet';
import { LocalHitChips, SourceChips } from '../SourceChips';
import { TileGrid } from '../ui/Brief';
import { Button } from '../ui/Button';
import { cardEdge } from '../ui/Card';
import { Icon, PageIcon, type LucideIcon } from '../ui/Icon';
import { pressedStyle } from '../ui/motion';

/** The glowing round mark of the assistant (header 40, empty state 76). */
export function AssistantMark({ size = 40 }: { size?: number }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.center,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.brand },
        { shadowColor: theme.colors.brand, shadowOpacity: 0.55, shadowRadius: size / 3, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
      ]}
    >
      <MessageCircleMore size={size * 0.48} color={theme.colors.onBrand} strokeWidth={theme.icon.strokeWidth} />
    </View>
  );
}

/** «Сегодня» — the day between messages, a `surfaceSunken` chip in the middle. */
export function DaySeparator({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.center, { marginVertical: theme.space[1] }]} accessibilityRole="header">
      <View style={{ backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.round, paddingHorizontal: theme.space[3], paddingVertical: 4 }}>
        <AppText variant="footnote" color="ink2">
          {label}
        </AppText>
      </View>
    </View>
  );
}

/**
 * What the person said: right, filled `brand`, `onBrand` text. Said in the line of another tab: a caption
 * «с вкладки «Заметки»» above (v4 `FromTabCaption`) — one conversation, two ways in.
 */
export function UserBubble({ m, testID }: { m: ChatMessage; testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const fromTab = m.pageId !== 'assistant' && m.pageTitle ? m.pageTitle : null;
  return (
    <View style={{ alignItems: 'flex-end', gap: 4 }}>
      {fromTab ? (
        <AppText testID={testID ? `${testID}-from` : undefined} variant="caption" color="ink2">
          {t('assistant.from_tab', { page: fromTab })}
        </AppText>
      ) : null}
      <View
        testID={testID}
        accessible
        accessibilityLabel={t('chat.you', { text: m.text })}
        style={{ maxWidth: '86%', backgroundColor: theme.colors.brand, borderRadius: theme.radius.lg, borderBottomRightRadius: theme.radius.xs, paddingHorizontal: theme.space[4], paddingVertical: theme.space[2] + 2 }}
      >
        <AppText style={{ color: theme.colors.onBrand }}>{m.text}</AppText>
      </View>
    </View>
  );
}

/** The answer: left, no bubble. A short answer is a value (`answerValue`) with its note; sources as chips. */
export function AssistantMessage({ m, testID }: { m: ChatMessage; testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hits = m.status === 'queued' ? (m.localHits ?? []) : [];
  const titles = useLocalHitTitles(m.status === 'queued' ? m.localHits : undefined, t);
  // Ф-50: a checked short answer is one big value — only when the server says so (`banner.value`).
  const value = !m.action && m.text && m.value ? { value: m.value, note: m.text.trim() !== m.value ? m.text : null } : null;
  const notice = m.saved ? null : answerNotice(m, t);
  return (
    <View testID={testID} style={{ gap: theme.space[2], alignItems: 'stretch' }}>
      {m.saved ? (
        <View style={[styles.row, { gap: 6 }]}>
          <Icon icon={Clock} size="sm" color="ink3" />
          <AppText variant="footnote">{t('assistant.saved_later')}</AppText>
        </View>
      ) : null}
      {m.status === 'streaming' && !m.text ? <AppText color="ink2">{m.activity ?? t('assistant.thinking')}</AppText> : null}
      {m.action ? <ActionResultCard m={m} action={m.action} /> : null}
      {value ? (
        <View>
          <AppText testID={testID ? `${testID}-value` : undefined} variant="answerValue">
            {value.value}
          </AppText>
          {value.note ? <AppText variant="footnote">{value.note}</AppText> : null}
        </View>
      ) : m.text && !m.action && !m.saved ? (
        <AppText testID={testID ? `${testID}-text` : undefined}>{m.text}</AppText>
      ) : null}
      {m.proposal && !m.proposal.answered ? (
        <View style={{ gap: theme.space[2] }}>
          <AppText>{m.proposal.question}</AppText>
          <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
            {m.proposal.options.map((o) => (
              <Button
                key={o.id}
                testID={`chat-option-${o.id}`}
                label={o.label}
                size="small"
                variant={o.id === m.proposal?.defaultId ? 'primary' : 'secondary'}
                onPress={() => void answerProposal(m.id, o.id)}
              />
            ))}
          </View>
        </View>
      ) : null}
      {notice ? <AppText variant="callout">{notice}</AppText> : null}
      {hits.length > 0 ? <LocalHitChips messageId={m.id} recordIds={hits} titles={titles} /> : null}
      {m.sources && m.sources.length > 0 ? <SourceChips messageId={m.id} sources={m.sources} /> : null}
      {/* R-06: the one label on AI-made content, shown whole. */}
      {m.status === 'done' && m.aiGenerated && !!m.text && !m.action ? (
        <AiLabel testID={testID ? `${testID}-ai` : undefined} variant="footnote" />
      ) : null}
    </View>
  );
}

/** The record a change is about, once it is on the phone (it may still come by /sync). */
async function recordOf(serverId: string | null): Promise<LocalRecord | null> {
  if (!serverId) return null;
  const repo = await getRecords();
  const rec = await repo.findByServerId(serverId);
  if (rec) return rec;
  kickSync();
  return null;
}

/**
 * The result of a change in the conversation (v4 `ActionResultCard` / `MultiActionCard`): one result — the page's
 * square, what, «Дела · завтра, 10:00», ✓ and «Переложить · Отменить»; several — «Сделал 3 дела», a row per place
 * (each opens it) and «Переложить · Отменить всё». Undone: «отменено». It stays in the conversation.
 */
export function ActionResultCard({ m, action }: { m: ChatMessage; action: ChatAction }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { title } = usePageLabels();
  const pages = usePages((s) => s.pages);
  const showToast = useToast((s) => s.show);
  const [replace, setReplace] = useState<{ record: LocalRecord; what: string; from: Page | null } | null>(null);
  const rows = action.changes.filter((c) => c.itemId || c.text);
  const many = rows.length > 1;
  const pageByServer = (id: string | null) => (id ? (pages.find((p) => p.serverId === id) ?? null) : null);
  const firstPage = pageByServer(action.savedTo?.[0]?.pageServerId ?? action.pageServerId);
  const done = !action.undone;
  const open = async (itemId: string | null) => {
    const rec = await recordOf(itemId);
    if (rec) router.navigate({ pathname: '/record/[id]', params: { id: rec.id } });
    else showToast(t('save.replace_later'), 3000);
  };
  const doReplace = async () => {
    const itemId = action.savedTo?.[0]?.itemIds[0] ?? action.changedItemIds[0] ?? rows[0]?.itemId ?? null;
    const rec = await recordOf(itemId);
    if (!rec) return showToast(t('save.replace_later'), 3000);
    setReplace({ record: rec, what: rows[0]?.title ?? actionText(action, i18n.language), from: firstPage });
  };
  const square = (icon: LucideIcon | null, page: Page | null) => (
    <View style={[styles.center, { width: 36, height: 36, borderRadius: theme.radius.sm, backgroundColor: theme.colors.brandTint }]}>
      {page ? <PageIcon name={page.icon} color={theme.colors.brand} size={20} /> : <Icon icon={icon ?? Check} size="sm" color="brand" />}
    </View>
  );
  const card = [{ backgroundColor: theme.colors.surface, borderRadius: theme.radius.xl, padding: theme.space[3], gap: theme.space[2] }, theme.elevation.card, cardEdge(theme)];
  return (
    <View testID={`chat-action-${m.id}`} style={card}>
      {many ? (
        <>
          <View style={[styles.row, { gap: theme.space[2] }]}>
            <View style={[styles.center, { width: 20, height: 20, borderRadius: 10, backgroundColor: done ? theme.colors.brand : theme.colors.iconSecondary }]}>
              <Check size={13} color={theme.colors.onBrand} strokeWidth={2.5} />
            </View>
            <AppText variant="bodyStrong" color="brand" style={done ? undefined : styles.struck}>
              {t('assistant.did_many', { count: rows.length })}
            </AppText>
          </View>
          {rows.map((c, i) => {
            const page = pageByServer(action.savedTo?.find((st) => c.itemId && st.itemIds.includes(c.itemId))?.pageServerId ?? action.pageServerId);
            return (
              <Pressable
                key={`${c.itemId ?? 'x'}-${i}`}
                testID={`chat-action-row-${i}`}
                accessibilityRole="button"
                onPress={() => void open(c.itemId)}
                style={({ pressed }) => [
                  styles.row,
                  { gap: theme.space[3], minHeight: theme.size.rowHeightMeta, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: theme.colors.separator },
                  pressedStyle(pressed),
                ]}
              >
                {square(StickyNote, page)}
                <View style={styles.flex}>
                  <AppText style={done ? undefined : styles.struck}>{c.title ?? c.text}</AppText>
                  {page ? <AppText variant="footnote">{title(page)}</AppText> : null}
                </View>
                <Icon icon={ChevronRight} size="sm" color="iconSecondary" />
              </Pressable>
            );
          })}
        </>
      ) : (
        <View style={[styles.row, { gap: theme.space[3] }]}>
          {square(Check, firstPage)}
          <View style={styles.flex}>
            <AppText variant="headline" style={done ? undefined : styles.struck}>
              {rows[0]?.title ?? actionText(action, i18n.language)}
            </AppText>
            {firstPage || action.pageTitle ? <AppText variant="footnote">{firstPage ? title(firstPage) : action.pageTitle}</AppText> : null}
          </View>
          {done ? (
            <View style={[styles.center, { width: 26, height: 26, borderRadius: 13, backgroundColor: theme.colors.brand }]}>
              <Check size={15} color={theme.colors.onBrand} strokeWidth={2.5} />
            </View>
          ) : null}
        </View>
      )}
      {done ? (
        action.undoable ? (
          <View style={[styles.row, { justifyContent: 'flex-end', gap: theme.space[1], flexWrap: 'wrap' }]}>
            {(action.savedTo?.length ?? 0) > 0 || action.kind === 'save_item' ? (
              <Button testID={`chat-replace-${m.id}`} label={t('save.replace')} variant="text" onPress={() => void doReplace()} />
            ) : null}
            <Button testID={`chat-undo-${m.id}`} label={many ? t('assistant.undo_all') : t('common.undo')} variant="text" onPress={() => void undoAction(m.id)} />
          </View>
        ) : null
      ) : (
        <AppText testID={`chat-undone-${m.id}`} variant="footnote" style={[styles.struck, { alignSelf: 'flex-end' }]}>
          {t('assistant.undone')}
        </AppText>
      )}
      {replace ? <ReplaceSheet record={replace.record} what={replace.what} from={replace.from} onClose={() => setReplace(null)} /> : null}
    </View>
  );
}

/** «Нет связи. Всё, что скажете, сохраню и разберу позже» (v4 §10.4). */
export function OfflineBanner() {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID="chat-offline" style={[styles.row, { gap: theme.space[3], backgroundColor: theme.colors.surfaceSunken, borderRadius: theme.radius.lg, padding: theme.space[3] }]}>
      <Icon icon={CloudOff} size="sm" color="ink2" />
      <AppText variant="callout" color="ink" style={styles.flex}>
        {t('assistant.offline')}
      </AppText>
    </View>
  );
}

const EXAMPLES: { key: string; icon: LucideIcon; phrase: boolean }[] = [
  { key: 'remember', icon: StickyNote, phrase: true },
  { key: 'forward', icon: FileUp, phrase: false },
  { key: 'find', icon: Search, phrase: true },
  { key: 'plan', icon: MapIcon, phrase: true },
];

/**
 * A new conversation (v4 «Помощник · первый раз»): the glowing mark, the one line for people «Скажите или перешлите — я
 * разложу по местам и найду, когда понадобится», four examples (a tap puts the phrase into the line) and «Ваши записи
 * видите только вы».
 */
export function ChatEmpty() {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID="chat-empty" style={{ alignItems: 'center', gap: theme.space[4], paddingTop: theme.space[4] }}>
      <View style={[styles.center, { width: 92, height: 92, borderRadius: 46, backgroundColor: withAlpha(theme.colors.brand, 0.14) }]}>
        <AssistantMark size={72} />
      </View>
      <AppText testID="chat-tagline" variant="title1" style={{ textAlign: 'center' }}>
        {t('assistant.tagline')}
      </AppText>
      <View style={{ alignSelf: 'stretch' }}>
        <TileGrid testID="chat-examples">
          {EXAMPLES.map((e) => (
            <Pressable
              key={e.key}
              testID={`chat-example-${e.key}`}
              accessibilityRole="button"
              onPress={() => {
                if (e.phrase) useView.getState().requestLine({ kind: 'text', text: t(`assistant.example_${e.key}_phrase`) });
              }}
              style={({ pressed }) => [
                { backgroundColor: theme.colors.surface, borderRadius: theme.radius.xl, padding: theme.space[3], gap: theme.space[2], minHeight: 112 },
                theme.elevation.card,
                cardEdge(theme),
                pressedStyle(pressed),
              ]}
            >
              <View style={[styles.center, { width: 32, height: 32, borderRadius: theme.radius.sm, backgroundColor: theme.colors.brandTint }]}>
                <Icon icon={e.icon} size="sm" color="brand" />
              </View>
              <AppText variant="headline">{t(`assistant.example_${e.key}`)}</AppText>
              <AppText variant="footnote">{t(`assistant.example_${e.key}_hint`)}</AppText>
            </Pressable>
          ))}
        </TileGrid>
      </View>
      <AppText variant="footnote" color="ink2">
        {t('assistant.private')}
      </AppText>
    </View>
  );
}

/** «Вернул как было» after an undo by phrase (v4 `UndoResultCard`) — a small card with what came back. */
export function UndoMark() {
  const theme = useTheme();
  return <Icon icon={Undo2} size="sm" color={theme.colors.brand} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  struck: { textDecorationLine: 'line-through' },
});
