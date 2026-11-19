import { router } from 'expo-router';
import { AiLabel } from '@/components/AiLabel';
import {
  Clock,
  Film,
  Link2,
  CloudOff,
  CreditCard,
  Lock,
  MessageSquareText,
  StickyNote,
  Sun,
  Undo2,
  ListChecks,
  Ellipsis,
} from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { actionText, answerProposal, retry, undoAction } from '@/chat/service';
import { getRecords, type LocalRecord } from '@/db';
import { usePageLabels } from '@/pages/usePageLabels';
import { kickSync } from '@/services';
import type { ChatAction, ChatMessage } from '@/store/assistant';
import { useConnectivity } from '@/store/connectivity';
import { usePages, type Page } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useView } from '@/store/view';
import { placeOfTemplate, useTheme, type PlaceKey } from '@/theme';

import { AppText } from '../AppText';
import { answerNotice, useLocalHitTitles } from '../answerText';
import { ReplaceSheet } from '../ReplaceSheet';
import { LocalHitChips, SourceChips } from '../SourceChips';
import { answerBody, WebSources } from '../WebSources';
import { Button } from '../ui/Button';
import { ResultCard } from '../ui/Floating';
import { Icon, type LucideIcon } from '../ui/Icon';
import { BigNumber, Inset, PlaceTab, Row } from '../ui/Leaf';
import { pressedStyle } from '../ui/motion';

/** The assistant's mark: the terracotta circle with the chat icon (onboarding, empty states). No glow (v5). */
export function AssistantMark({ size = 40 }: { size?: number }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.center,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: theme.colors.place.assistant },
      ]}
    >
      <MessageSquareText size={size * 0.48} color={theme.colors.onSheet} strokeWidth={theme.icon.strokeWidth} />
    </View>
  );
}

/** «Сегодня, 9:38» — the day between messages: a centred caption (`ink3` 13). */
export function DaySeparator({ label }: { label: string }) {
  return (
    <View style={styles.center} accessibilityRole="header">
      <AppText variant="footnote" style={{ textAlign: 'center' }}>
        {label}
      </AppText>
    </View>
  );
}

/**
 * What the person said (`.me`): right, `btn` fill, `onBtn` text 16, radius 20 20 6 20, ≤ 82 %. Said in the line of
 * another tab: a caption «с вкладки «Заметки»» above — one conversation, two ways in.
 */
export function UserBubble({ m, testID }: { m: ChatMessage; testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const fromTab = m.pageId !== 'assistant' && m.pageTitle ? m.pageTitle : null;
  return (
    <View style={{ alignItems: 'flex-end', gap: 4 }}>
      {fromTab ? (
        <AppText testID={testID ? `${testID}-from` : undefined} variant="caption">
          {t('assistant.from_tab', { page: fromTab })}
        </AppText>
      ) : null}
      {m.shared ? (
        // screens-v5-extra «Поделились ссылкой»: a paper2 card on the right, «видео по ссылке · вы поделились».
        <Pressable
          testID={testID ? `${testID}-shared` : undefined}
          accessibilityRole="button"
          accessibilityLabel={`${t(`chat.shared_${m.shared.kind}`)}. ${m.text}`}
          onPress={() => router.navigate({ pathname: '/record/[id]', params: { id: m.shared!.recordId } })}
          style={({ pressed }) => ({
            maxWidth: '84%',
            backgroundColor: theme.colors.paper2,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderBottomRightRadius: 6,
            borderBottomLeftRadius: 20,
            paddingHorizontal: 15,
            paddingVertical: 12,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <View style={[styles.row, { gap: 6 }]}>
            {m.shared.kind === 'video' ? (
              <Film size={14} color={theme.colors.ink3} />
            ) : (
              <Link2 size={14} color={theme.colors.ink3} />
            )}
            <AppText variant="caption" style={{ color: theme.colors.ink3 }}>
              {t(`chat.shared_${m.shared.kind}`)}
            </AppText>
          </View>
          <AppText
            numberOfLines={3}
            style={{ marginTop: 4, fontFamily: theme.type.headline.fontFamily, fontSize: 16, lineHeight: 21 }}
          >
            {m.text}
          </AppText>
        </Pressable>
      ) : (
        <View
          testID={testID}
          accessible
          accessibilityLabel={t('chat.you', { text: m.text })}
          style={{
            maxWidth: '82%',
            backgroundColor: theme.colors.btn,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderBottomRightRadius: 6,
            borderBottomLeftRadius: 20,
            paddingHorizontal: 15,
            paddingVertical: 11,
          }}
        >
          <AppText style={{ color: theme.colors.onBtn, lineHeight: 22 }}>{m.text}</AppText>
        </View>
      )}
    </View>
  );
}

/** The answer (`.bot`): left, no bubble, 16.5 medium. A short answer is the ONE big number with its note beside. */
export function AssistantMessage({ m, testID }: { m: ChatMessage; testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hits = m.status === 'queued' ? (m.localHits ?? []) : [];
  const titles = useLocalHitTitles(m.status === 'queued' ? m.localHits : undefined, t);
  // Ф-50: a checked short answer is one big value — only when the server says so (`banner.value`).
  const value =
    !m.action && m.text && m.value ? { value: m.value, note: m.text.trim() !== m.value ? m.text : null } : null;
  const notice = m.saved ? null : answerNotice(m, t);
  // QA v5-device-1 «Помощник» 2: a broken answer says why and offers «Повторить»; without a connection — the cloud
  // (§11.3). Not for the calm notices (limit, no AI, saved for later, «может, уже сделано»).
  const online = useConnectivity((st) => st.online);
  const retryable =
    (m.status === 'interrupted' && m.notice !== 'maybe_done') ||
    (m.status === 'failed' &&
      (!m.notice || m.notice === 'error' || m.notice === 'no_answer' || m.notice === 'not_understood'));
  return (
    <View testID={testID} style={{ gap: theme.space[2], alignItems: 'stretch' }}>
      {m.saved ? (
        <View style={[styles.row, { gap: 5, justifyContent: 'flex-end' }]}>
          <Icon icon={Clock} size="sm" color="ink3" />
          <AppText variant="footnote">{t('assistant.saved_later')}</AppText>
        </View>
      ) : null}
      {m.status === 'streaming' && !m.text ? (
        <AppText variant="chat" color="ink2">
          {m.activity ?? t('assistant.thinking')}
        </AppText>
      ) : null}
      {m.action && (m.action.undoOf || (m.action.undid?.length ?? 0) > 0) ? (
        <UndoResultCard m={m} action={m.action} />
      ) : m.action ? (
        <ActionResultCard m={m} action={m.action} />
      ) : null}
      {value ? (
        <View style={[styles.row, { alignItems: 'flex-end', gap: 12 }]}>
          <View>
            <BigNumber testID={testID ? `${testID}-value` : undefined} value={value.value} />
          </View>
          {value.note ? (
            <AppText variant="small" style={[styles.flex, { paddingBottom: 5 }]}>
              {value.note}
            </AppText>
          ) : null}
        </View>
      ) : m.text && !m.action && !m.saved ? (
        <AppText testID={testID ? `${testID}-text` : undefined} variant="chat">
          {answerBody(m)}
        </AppText>
      ) : null}
      {m.proposal && !m.proposal.answered ? (
        <View style={{ gap: theme.space[2] }}>
          <AppText variant="chat">{m.proposal.question}</AppText>
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
      {/* screens-v5-extra «на сегодня хватит», «Ответ не дошёл»: a calm plate on the paper, never red. */}
      {notice ? (
        <Inset
          testID={testID ? `${testID}-notice` : undefined}
          style={retryable ? [styles.row, { alignItems: 'flex-start', gap: 12 }] : undefined}
        >
          {retryable && !online ? (
            <View
              testID={testID ? `${testID}-offline` : undefined}
              accessible
              accessibilityLabel={t('assistant.offline_short')}
            >
              <CloudOff size={22} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
            </View>
          ) : null}
          <View style={retryable ? [styles.flex, { gap: 10 }] : undefined}>
            <AppText style={{ fontSize: 15.5, lineHeight: 22 }}>{notice}</AppText>
            {retryable ? (
              <View style={styles.row}>
                <Button
                  testID={`chat-retry-${m.id}`}
                  label={t('answer.retry_short')}
                  variant="link"
                  onPress={() => void retry(m.id)}
                />
              </View>
            ) : null}
          </View>
        </Inset>
      ) : null}
      {hits.length > 0 ? <LocalHitChips messageId={m.id} recordIds={hits} titles={titles} /> : null}
      {m.sources && m.sources.length > 0 ? <SourceChips messageId={m.id} sources={m.sources} /> : null}
      <WebSources m={m} />
      {m.status === 'done' && m.aiGenerated && !!m.text && !m.action ? (
        <AiLabel testID={testID ? `${testID}-ai` : undefined} variant="footnote" />
      ) : null}
    </View>
  );
}

/** The icon of a place on a result sheet. */
const PLACE_ICON: Record<PlaceKey, LucideIcon> = {
  today: Sun,
  notes: StickyNote,
  assistant: MessageSquareText,
  expenses: CreditCard,
  tasks: ListChecks,
  stone: Ellipsis,
};

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
 * The result of a change in the conversation (screens-v5 «Помощник · разговор»): each thing made is a small sheet in
 * the colour of its place («Дела · завтра, 10:00» over «Позвонить в ЦОН»; a tap opens it), then «Переложить» (an
 * ordinary link) · «Отменить» / «Отменить всё» (terracotta: the assistant's action). Undone: struck, «отменено».
 */
export function ActionResultCard({ m, action }: { m: ChatMessage; action: ChatAction }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { title } = usePageLabels();
  const pages = usePages((s) => s.pages);
  const showToast = useToast((s) => s.show);
  const [replace, setReplace] = useState<{ record: LocalRecord; what: string; from: Page | null } | null>(null);
  // Step 6: a phrase with several actions — a row per action; else a row per record of the one action.
  const parts = action.parts && action.parts.length > 1 ? action.parts : null;
  const rows: {
    itemId: string | null;
    title: string | null;
    text: string;
    pageServerId: string | null;
    undone: boolean;
  }[] = parts
    ? parts.map((p) => ({
        itemId: p.changes[0]?.itemId ?? p.changedItemIds[0] ?? null,
        title: p.changes[0]?.title ?? null,
        text: actionText(p, i18n.language),
        pageServerId: p.savedTo?.[0]?.pageServerId ?? p.pageServerId,
        undone: !!p.undone,
      }))
    : action.changes
        .filter((c) => c.itemId || c.text)
        .map((c) => ({
          itemId: c.itemId,
          title: c.title,
          text: c.text,
          pageServerId:
            action.savedTo?.find((st) => c.itemId && st.itemIds.includes(c.itemId))?.pageServerId ??
            action.pageServerId,
          undone: !!action.undone,
        }));
  const many = rows.length > 1;
  const groupNotice = action.group?.notice;
  const canUndo = parts ? parts.some((p) => p.undoable && !p.undone) : action.undoable;
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
  const shown =
    rows.length > 0
      ? rows
      : [
          {
            itemId: null,
            title: null,
            text: actionText(action, i18n.language),
            pageServerId: action.pageServerId,
            undone: !!action.undone,
          },
        ];
  return (
    <View testID={`chat-action-${m.id}`} style={{ gap: 6 }}>
      {many && groupNotice ? (
        <AppText variant="chat">{(i18n.language === 'kk' && groupNotice.text_kk) || groupNotice.text_ru}</AppText>
      ) : null}
      {many && !groupNotice ? (
        <AppText variant="chat">{t('assistant.did_many', { count: rows.length })}</AppText>
      ) : null}
      {shown.map((c, i) => {
        const page = pageByServer(c.pageServerId) ?? (i === 0 ? firstPage : null);
        const place = page ? placeOfTemplate(page.templateKey) : 'stone';
        const caption = page ? title(page) : (action.pageTitle ?? t('assistant.saved'));
        return (
          <ResultCard
            key={`${c.itemId ?? 'x'}-${i}`}
            testID={many ? `chat-action-row-${i}` : undefined}
            place={place}
            icon={PLACE_ICON[place]}
            caption={c.title && c.text && c.text !== c.title && many ? `${caption} · ${c.text}` : caption}
            title={c.title ?? c.text}
            onPress={() => void open(c.itemId)}
            style={c.undone || !done ? { opacity: 0.55 } : undefined}
          />
        );
      })}
      {done ? (
        canUndo ? (
          <View style={[styles.row, { gap: 4, flexWrap: 'wrap', marginTop: 4 }]}>
            {(action.savedTo?.length ?? 0) > 0 || action.kind === 'save_item' ? (
              <>
                <Button
                  testID={`chat-replace-${m.id}`}
                  label={t('save.replace')}
                  variant="link"
                  size="small"
                  onPress={() => void doReplace()}
                />
                <AppText variant="small" color="ink3" accessibilityElementsHidden importantForAccessibility="no">
                  ·
                </AppText>
              </>
            ) : null}
            <Pressable
              testID={`chat-undo-${m.id}`}
              accessibilityRole="button"
              accessibilityLabel={many ? t('assistant.undo_all') : t('common.undo')}
              onPress={() => void undoAction(m.id)}
              hitSlop={8}
              style={({ pressed }) => [
                { minHeight: theme.size.minTouch, justifyContent: 'center', paddingHorizontal: 8 },
                pressedStyle(pressed),
              ]}
            >
              <AppText
                style={{
                  color: theme.colors.assistantText,
                  fontFamily: theme.type.headline.fontFamily,
                  fontSize: 15,
                  lineHeight: 18,
                }}
              >
                {many ? t('assistant.undo_all') : t('common.undo')}
              </AppText>
            </Pressable>
          </View>
        ) : null
      ) : (
        <AppText testID={`chat-undone-${m.id}`} variant="footnote" style={styles.struck}>
          {t('assistant.undone')}
        </AppText>
      )}
      {replace ? (
        <ReplaceSheet
          record={replace.record}
          what={replace.what}
          from={replace.from}
          onClose={() => setReplace(null)}
        />
      ) : null}
    </View>
  );
}

/** «Нет связи. Всё, что скажете, сохраню и разберу позже» on the paper (no small text on terracotta). */
export function OfflineBanner() {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Inset testID="chat-offline" style={[styles.row, { alignItems: 'flex-start', gap: 12 }]}>
      <CloudOff size={22} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
      <AppText style={[styles.flex, { fontSize: 15.5, lineHeight: 22 }]}>
        <AppText style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 15.5 }}>
          {t('assistant.offline_title')}
        </AppText>{' '}
        {t('assistant.offline_rest')}
      </AppText>
    </Inset>
  );
}

const EXAMPLES: { key: string; place: PlaceKey }[] = [
  { key: 'note', place: 'notes' },
  { key: 'spend', place: 'expenses' },
  { key: 'task', place: 'tasks' },
  { key: 'find', place: 'stone' },
];

/**
 * A new conversation (screens-v5 «Помощник · первый раз»): the one big line, «Можно начать так» with four example
 * rows — each has the colour of the place its record will go to; a tap puts the phrase into the field — and
 * «Ваши записи видите только вы».
 */
export function ChatEmpty() {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID="chat-empty">
      <AppText testID="chat-tagline" variant="title1" style={{ marginTop: 18 }}>
        {t('assistant.tagline')}
      </AppText>
      <AppText variant="section" accessibilityRole="header" style={{ marginTop: 26, marginBottom: 6 }}>
        {t('assistant.start_like')}
      </AppText>
      <View testID="chat-examples">
        {EXAMPLES.map((e, i) => (
          <Row
            key={e.key}
            first={i === 0}
            testID={`chat-example-${e.key}`}
            accessibilityLabel={t(`assistant.ex_${e.key}`)}
            onPress={() => useView.getState().requestLine({ kind: 'text', text: t(`assistant.ex_${e.key}_phrase`) })}
          >
            <PlaceTab place={e.place} />
            <AppText numberOfLines={1} style={styles.flex}>
              {t(`assistant.ex_${e.key}`)}
            </AppText>
          </Row>
        ))}
      </View>
      <View style={[styles.row, { gap: 6, marginTop: 14 }]}>
        <Lock size={15} color={theme.colors.ink3} strokeWidth={theme.icon.strokeWidth} />
        <AppText variant="footnote">{t('assistant.private')}</AppText>
      </View>
    </View>
  );
}

/**
 * «Вернул как было» after an undo by phrase (Ф-67): ↩ and the server's words, what came back, and «Открыть
 * «Историю»». The action it undid says «отменено» where it is in the conversation.
 */
export function UndoResultCard({ m, action }: { m: ChatMessage; action: ChatAction }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const head = action.notice
    ? (i18n.language === 'kk' && action.notice.text_kk) || action.notice.text_ru
    : t('assistant.undid');
  const body = actionText(action, i18n.language);
  return (
    <Inset testID={`chat-undo-result-${m.id}`} style={{ gap: theme.space[2] }}>
      <View style={[styles.row, { gap: 12 }]}>
        <Undo2 size={22} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
        <View style={styles.flex}>
          <AppText variant="headline">{head}</AppText>
          {body && body !== head ? <AppText variant="footnote">{body}</AppText> : null}
        </View>
      </View>
      <View style={[styles.row, { justifyContent: 'flex-end' }]}>
        <Button
          testID={`chat-open-history-${m.id}`}
          label={t('assistant.open_history')}
          variant="link"
          size="small"
          onPress={() => router.push('/history')}
        />
      </View>
    </Inset>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  struck: { textDecorationLine: 'line-through' },
});
