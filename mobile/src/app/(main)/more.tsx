import { router } from 'expo-router';
import { FileText, Inbox, LayoutGrid, LayoutList, Search, Settings, ShieldAlert, Trash2 } from 'lucide-react-native';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { clockOf } from '@/alarms/format';
import { AppText } from '@/components/AppText';
import { PageNameSheet } from '@/components/PageNameSheet';
import { Screen } from '@/components/Screen';
import { Header } from '@/components/ui/Header';
import { AlarmRiskRow } from '@/components/ReminderCards';
import type { LucideIcon } from '@/components/ui/Icon';
import { PlaceTab, Row, RowChevron, RowMeta, SectionHead } from '@/components/ui/Leaf';
import { getRecords } from '@/db';
import { useKp } from '@/kp/store';
import { addCustomPage, ensureTemplatePage } from '@/pages/service';
import { mainTabs } from '@/pages/tabs';
import { usePageLabels } from '@/pages/usePageLabels';
import { LIST_LIMIT, useLocalQuery, useTrash } from '@/records/useRecords';
import { useAssistant } from '@/store/assistant';
import { useFeatures } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { selectSortedPages, usePages } from '@/store/pages';
import { useSession } from '@/store/session';
import { useToast } from '@/store/toast';
import { localDate } from '@/tasks/rows';
import { isDone, liveTasks } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { placeOfTemplate, useTheme } from '@/theme';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

/**
 * S42 «Ещё» v2 (screens-v2 «Ещё»): the profile card, two tiles «Документы» and «История», then «Все записи» (the one
 * search: all records, by words), «Принести заметки», «Настройки» (тема, язык, будильники), «Помощь». Pages that are
 * not tabs follow as «Ваши страницы» with «+ Новая страница» (Ф-48: «Заметки» are here at a large font).
 * A sign-in that expired or a consent another account needs comes first, as a row of its own.
 */
export default function MoreScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { title } = usePageLabels();
  const pages = usePages(useShallow(selectSortedPages));
  const shopping = useFeatures((f) => f.shopping);
  const name = useOnboarding((s) => s.displayName);
  const phoneLinked = useOnboarding((s) => s.phoneLinkedAt !== null);
  const phone = useOnboarding((s) => s.phoneMasked);
  const needsConsent = useOnboarding((s) => s.accountConsent !== null);
  const needsSignIn = useSession((s) => s.needsSignIn);
  const showToast = useToast((s) => s.show);
  const docs = useKp((s) => s.docs);
  const actions = useTasks((s) => s.actions);
  const messages = useAssistant((s) => s.messages);
  const tasks = useTasks((s) => s.tasks);
  const ticks = useTasks((s) => s.ticks);
  const [naming, setNaming] = useState(false);
  const [todayKey] = useState(() => localDate(Date.now()));
  const records = useLocalQuery(async () => (await getRecords()).list(LIST_LIMIT), []);
  const { overflow } = mainTabs(pages, { largeFont: theme.largeFont, shopping });
  const shownOverflow = overflow.filter((p) => p.templateKey !== 'documents');

  const liveDocs = Object.values(docs).filter((d) => !d.deleted_at);
  const drafts = liveDocs.filter((d) => d.status === 'draft' || d.status === 'extracting').length;
  const today = new Date().toDateString();
  const todayActions = Object.values(actions).filter((a) => !a.undo_of && a.created_at && new Date(a.created_at).toDateString() === today);
  const todayTurns = messages.filter((m) => m.role === 'user' && new Date(m.at).toDateString() === today);
  const historyToday = todayTurns.length + todayActions.filter((a) => !a.message_id).length;
  const lastAction = [...todayActions].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];
  const time = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return clockOf(iso);
    }
  };
  const openTemplate = (k: 'tasks' | 'notes' | 'expenses') =>
    void ensureTemplatePage(k).then((p) => {
      // QA B «Дела» 6: opened from «Ещё» → «‹ Ещё» and the «Ещё» tab stay.
      if (p) router.navigate({ pathname: '/page/[id]', params: { id: p.id, from: 'more' } });
    });
  const tasksToday = liveTasks(tasks, 'todo').filter((x) => !!x.due_date && x.due_date <= todayKey && !isDone(x, ticks)).length;
  const openDocuments = () =>
    void ensureTemplatePage('documents').then((p) => {
      if (p) router.navigate({ pathname: '/page/[id]', params: { id: p.id } });
      else showToast(t('gallery.limit'), 4000);
    });
  const displayName = name ?? t('more.profile');
  const signInFirst = needsSignIn || !phoneLinked;
  const profileMeta = signInFirst ? t('more.sign_in_keep') : (phone ?? t('more.profile_hint'));

  const trash = useTrash();
  const row = (o: { id: string; title: string; meta?: string; lead: React.ReactNode; onPress: () => void; first?: boolean; label?: string }) => (
    <Row key={o.id} first={o.first} testID={o.id} accessibilityLabel={o.label ?? (o.meta ? `${o.title}. ${o.meta}` : o.title)} onPress={o.onPress}>
      {o.lead}
      <AppText numberOfLines={1} style={styles.flex}>
        {o.title}
      </AppText>
      {o.meta ? <RowMeta>{o.meta}</RowMeta> : null}
      <RowChevron />
    </Row>
  );
  const icon = (I: LucideIcon) => <I size={22} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />;

  return (
    <Screen testID="page-more" place="stone" peek={['expenses', 'assistant']} askRoom>
      <Header title={t('more.title')} actions={[{ key: 'search', icon: Search, label: t('today.search'), onPress: () => router.navigate('/search'), testID: 'more-search' }]} />
      {needsConsent ? (
        <Row first testID="more-consent" onPress={() => router.push('/account-consent')} accessibilityLabel={`${t('account_consent.row')}. ${t('account_consent.row_hint')}`}>
          {icon(ShieldAlert)}
          <View style={styles.flex}>
            <AppText>{t('account_consent.row')}</AppText>
            <AppText variant="footnote">{t('account_consent.row_hint')}</AppText>
          </View>
          <RowChevron />
        </Row>
      ) : null}

      {/* QA v2 §5.1: one profile row — signed in: the masked number; not yet / expired: the sign-in, here. */}
      <Row
        first={!needsConsent}
        testID="more-profile"
        accessibilityLabel={`${displayName}. ${profileMeta}`}
        onPress={() => (signInFirst ? router.push(needsSignIn ? '/phone?reason=expired' : '/phone') : router.push('/settings'))}
        style={{ minHeight: 64 }}
      >
        <View style={[styles.avatar, { backgroundColor: theme.colors.paper2 }]}>
          <AppText style={{ fontFamily: theme.type.title.fontFamily, fontSize: 16 }}>{name ? initials(name) : '·'}</AppText>
        </View>
        <View style={styles.flex}>
          <AppText variant="headline">{displayName}</AppText>
          <AppText testID="profile-meta" variant="footnote" style={{ fontVariant: ['tabular-nums'] }}>
            {profileMeta}
          </AppText>
        </View>
        <RowChevron />
      </Row>
      {/* «Дела» left the tab bar for the centre «Помощник»: a row here, «Все дела ›» on «Сегодня». */}
      {row({ id: 'more-tasks', title: t('more.tasks'), meta: t('more.tasks_meta', { n: tasksToday }), lead: <PlaceTab place="tasks" />, onPress: () => openTemplate('tasks') })}
      {row({ id: 'more-documents', title: t('more.documents'), meta: drafts > 0 ? `${drafts} ${t('more.drafts', { count: drafts })}` : undefined, lead: icon(FileText), onPress: openDocuments })}
      {/* Ф-77: the imported chats live apart from «Заметки». */}
      {row({ id: 'more-ai-chats', title: t('aichats.title'), lead: icon(Inbox), onPress: () => router.navigate('/ai-chats') })}
      {row({
        id: 'more-history',
        title: t('more.history'),
        meta: historyToday > 0 ? t('more.history_today', { n: historyToday }) : undefined,
        lead: <PlaceTab place="assistant" />,
        onPress: () => router.push('/history'),
        label: `${t('more.history')}. ${historyToday > 0 && lastAction?.created_at ? t('more.last_at', { time: time(lastAction.created_at) }) : t('more.history_hint')}`,
      })}
      {row({ id: 'more-records', title: t('more.all_records'), meta: records ? String(records.length) : undefined, lead: icon(LayoutGrid), onPress: () => router.navigate('/records') })}
      {row({ id: 'more-trash', title: t('trash.short'), meta: trash && trash.length > 0 ? String(trash.length) : undefined, lead: icon(Trash2), onPress: () => router.navigate('/trash') })}
      {row({ id: 'more-settings', title: t('more.settings'), lead: icon(Settings), onPress: () => router.push('/settings') })}

      {/* QA v5-device-1 B «Ещё» 1: the list ends at «Настройки» (import is inside «Переписки», help in «Настройки»).
          Pages that are not tabs (a custom page, «Покупки») stay reachable while there are any. */}
      <AlarmRiskRow />
      {shownOverflow.filter((p) => p.templateKey !== 'tasks').length > 0 ? (
        <>
          <SectionHead title={t('more.your_pages')} />
          {shownOverflow
            .filter((p) => p.templateKey !== 'tasks')
            .map((p, i) =>
              row({
                id: `more-page-${p.id}`,
                first: i === 0,
                title: title(p),
                lead: <PlaceTab place={placeOfTemplate(p.templateKey)} />,
                onPress: () => router.navigate({ pathname: '/page/[id]', params: { id: p.id } }),
              }),
            )}
          {row({ id: 'more-my_pages', title: t('more.my_pages'), lead: icon(LayoutList), onPress: () => router.navigate('/my-pages') })}
        </>
      ) : null}
      {naming ? (
        <PageNameSheet
          onClose={() => setNaming(false)}
          onSave={(pageName) => {
            setNaming(false);
            void addCustomPage(pageName).then((page) => {
              if (page) router.navigate({ pathname: '/page/[id]', params: { id: page.id } });
              else showToast(t('gallery.limit'), 4000);
            });
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  avatar: { minWidth: 48, minHeight: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
