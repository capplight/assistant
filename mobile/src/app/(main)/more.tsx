import { router } from 'expo-router';
import { ChevronRight, CircleHelp, FolderInput, History, LayoutGrid, MessagesSquare, Plus, Search, Settings, ShieldAlert } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { AppText } from '@/components/AppText';
import { PageNameSheet } from '@/components/PageNameSheet';
import { Screen } from '@/components/Screen';
import { supportUrl } from '@/components/support';
import { MetricTile, TileGrid } from '@/components/ui/Brief';
import { cardEdge, ListGroup, ListRow } from '@/components/ui/Card';
import { Header } from '@/components/ui/Header';
import { Icon, PageIcon } from '@/components/ui/Icon';
import { pressedStyle } from '@/components/ui/motion';
import { getRecords } from '@/db';
import { formatMinor, periodOf } from '@/expenses/calc';
import { board, liveEntries } from '@/expenses/feed';
import { useExpenses } from '@/expenses/store';
import { useKp } from '@/kp/store';
import { addCustomPage, ensureTemplatePage } from '@/pages/service';
import { mainTabs } from '@/pages/tabs';
import { usePageLabels } from '@/pages/usePageLabels';
import { LIST_LIMIT, useLocalQuery } from '@/records/useRecords';
import { useAssistant } from '@/store/assistant';
import { useFeatures } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { selectSortedPages, usePages } from '@/store/pages';
import { useSession } from '@/store/session';
import { useToast } from '@/store/toast';
import { localDate } from '@/tasks/rows';
import { isDone, liveTasks } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { metricColors, useTheme } from '@/theme';

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
  const monthSpent = useExpenses((s) => {
    const today = localDate(Date.now());
    const m = board(liveEntries(s.entries, s.edits), periodOf('month', today), s.categories).main;
    return m?.currency === 'KZT' ? m.total : 0n;
  });
  const notesPage = pages.find((p) => p.templateKey === 'notes');
  const [naming, setNaming] = useState(false);
  const [todayKey] = useState(() => localDate(Date.now()));
  const records = useLocalQuery(async () => (await getRecords()).list(LIST_LIMIT), []);
  const { overflow } = mainTabs(pages, { largeFont: theme.largeFont, shopping });
  const shownOverflow = overflow.filter((p) => p.templateKey !== 'documents');
  const support = supportUrl();

  const liveDocs = Object.values(docs).filter((d) => !d.deleted_at);
  const drafts = liveDocs.filter((d) => d.status === 'draft' || d.status === 'extracting').length;
  const lastDoc = [...liveDocs].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0];
  const today = new Date().toDateString();
  const todayActions = Object.values(actions).filter((a) => !a.undo_of && a.created_at && new Date(a.created_at).toDateString() === today);
  const todayTurns = messages.filter((m) => m.role === 'user' && new Date(m.at).toDateString() === today);
  const historyToday = todayTurns.length + todayActions.filter((a) => !a.message_id).length;
  const lastAction = [...todayActions].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];
  const time = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso.slice(11, 16);
    }
  };
  const openTemplate = (k: 'tasks' | 'notes' | 'expenses') =>
    void ensureTemplatePage(k).then((p) => {
      if (p) router.navigate({ pathname: '/page/[id]', params: { id: p.id } });
    });
  const tasksToday = liveTasks(tasks, 'todo').filter((x) => !!x.due_date && x.due_date <= todayKey && !isDone(x, ticks)).length;
  const notesCount = notesPage ? (records ?? []).filter((r) => r.pageId === notesPage.id).length : 0;
  const spentText = formatMinor(monthSpent).replace(/\s?₸$/, '');
  const openDocuments = () =>
    void ensureTemplatePage('documents').then((p) => {
      if (p) router.navigate({ pathname: '/page/[id]', params: { id: p.id } });
      else showToast(t('gallery.limit'), 4000);
    });
  const displayName = name ?? t('more.profile');
  const signInFirst = needsSignIn || !phoneLinked;
  const profileMeta = signInFirst ? t('more.sign_in_keep') : (phone ?? t('more.profile_hint'));

  return (
    <Screen testID="page-more" edges={['top']}>
      <Header title={t('more.title')} />
      <View style={{ gap: theme.space[3] }}>
        {needsConsent ? (
          <ListGroup>
            {needsConsent ? (
              <ListRow testID="more-consent" icon={ShieldAlert} title={t('account_consent.row')} meta={t('account_consent.row_hint')} chevron onPress={() => router.push('/account-consent')} />
            ) : null}
          </ListGroup>
        ) : null}

        {/* QA v2 §5.1: one profile card — signed in: the masked number; not yet / expired: the sign-in, here. */}
        <Pressable
          testID="more-profile"
          accessibilityRole="button"
          accessibilityLabel={`${displayName}. ${profileMeta}`}
          onPress={() => (signInFirst ? router.push(needsSignIn ? '/phone?reason=expired' : '/phone') : router.push('/settings'))}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: theme.colors.surface, borderRadius: theme.radius.xxl, padding: theme.space[4], gap: theme.space[3] },
            theme.elevation.card,
            cardEdge(theme),
            pressedStyle(pressed),
          ]}
        >
          <View style={[styles.avatar, { backgroundColor: theme.colors.brand }]}>
            <AppText variant="headline" style={{ color: theme.colors.onBrand }}>
              {name ? initials(name) : '·'}
            </AppText>
          </View>
          <View style={styles.flex}>
            <AppText variant="headline">{displayName}</AppText>
            <AppText testID="profile-meta" variant="callout">
              {profileMeta}
            </AppText>
          </View>
          <Icon icon={ChevronRight} size="sm" color="iconSecondary" />
        </Pressable>

        <TileGrid testID="tiles-more">
          {/* Дела left the tab bar for the centre «Помощник» (VISION-2026-11): a tile here, «Все дела ›» on «Сегодня». */}
          <MetricTile
            testID="more-tasks"
            label={t('more.tasks')}
            value={String(tasksToday)}
            unit={t('more.on_today')}
            caption={tasksToday === 0 ? t('more.tasks_free') : t('more.tasks_ok')}
            color={metricColors[theme.scheme].reminders}
            onPress={() => openTemplate('tasks')}
          />
          {theme.largeFont ? (
            <>
              <MetricTile testID="more-notes" label={t('more.notes')} value={String(notesCount)} caption={t('more.notes_hint')} color={metricColors[theme.scheme].new} onPress={() => openTemplate('notes')} />
              <MetricTile testID="more-expenses" label={t('more.expenses')} value={spentText} unit="₸" caption={t('more.expenses_hint')} color={metricColors[theme.scheme].spent} onPress={() => openTemplate('expenses')} />
            </>
          ) : null}
          <MetricTile
            testID="more-documents"
            label={t('more.documents')}
            value={String(drafts)}
            unit={t('more.drafts', { count: drafts })}
            caption={lastDoc?.title ?? t('more.documents_empty')}
            color={metricColors[theme.scheme].tasks}
            onPress={openDocuments}
          />
        </TileGrid>

        <ListGroup>
          {/* v4 «Ещё»: «Принести переписку · ChatGPT, Claude, Gemini — всё в одном месте» (Telegram is inside). */}
          <ListRow testID="more-import" icon={FolderInput} title={t('more.import_chats')} meta={t('more.import_chats_hint')} chevron onPress={() => router.push('/ai-import')} />
          {/* Ф-77: the imported chats live apart from «Заметки». */}
          <ListRow testID="more-ai-chats" icon={MessagesSquare} title={t('aichats.title')} chevron onPress={() => router.navigate('/ai-chats')} />
          <ListRow
            testID="more-history"
            icon={History}
            title={t('more.history')}
            meta={historyToday > 0 && lastAction?.created_at ? t('more.last_at', { time: time(lastAction.created_at) }) : t('more.history_hint')}
            chevron
            onPress={() => router.push('/history')}
          />
          <ListRow
            testID="more-records"
            icon={Search}
            title={t('more.all_records')}
            meta={records ? t('more.records_count', { count: records.length }) : undefined}
            chevron
            onPress={() => router.navigate('/records')}
          />
          <ListRow testID="more-settings" icon={Settings} title={t('more.settings')} meta={t('more.settings_hint')} chevron onPress={() => router.push('/settings')} />
          {support ? <ListRow testID="more-help" icon={CircleHelp} title={t('more.help')} chevron onPress={() => void Linking.openURL(support).catch(() => undefined)} /> : null}
        </ListGroup>

        <ListGroup title={t('more.your_pages')}>
          {shownOverflow.map((p) => (
            <ListRow
              key={p.id}
              testID={`more-page-${p.id}`}
              left={
                <View style={[styles.square, { backgroundColor: theme.colors.brandTint, borderRadius: theme.radius.sm }]}>
                  <PageIcon name={p.icon} color={theme.colors.brand} size={20} />
                </View>
              }
              title={title(p)}
              chevron
              onPress={() => router.navigate({ pathname: '/page/[id]', params: { id: p.id } })}
            />
          ))}
          <ListRow testID="more-add_page" icon={Plus} title={t('more.add_page')} chevron onPress={() => setNaming(true)} />
          {/* Order, rename, remove the pages (S34): the tabs stay fixed (Ф-48), «Ваши страницы» follow this order. */}
          <ListRow testID="more-my_pages" icon={LayoutGrid} title={t('more.my_pages')} chevron onPress={() => router.navigate('/my-pages')} />
        </ListGroup>
      </View>
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
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  avatar: { minWidth: 52, minHeight: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  square: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
});
