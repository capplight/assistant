import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  ArrowUpDown,
  Camera,
  Ellipsis,
  FileText,
  LayoutGrid,
  List,
  PencilLine,
  Plus,
  QrCode,
  Search,
  SlidersHorizontal,
  Wallet,
  X,
} from 'lucide-react-native';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, BackHandler, View } from 'react-native';

import { renamePage } from '@/pages/service';
import { usePageLabels } from '@/pages/usePageLabels';
import { searchRecords } from '@/records/search';
import { usePageEntries } from '@/records/useRecords';
import { useServerSearch } from '@/records/useServerSearch';
import type { Page } from '@/store/pages';
import { useNotesLook } from '@/store/notesLook';
import { useFeatures } from '@/store/features';
import { useView } from '@/store/view';
import { placeOfTemplate, useTheme, type PlaceKey } from '@/theme';
import type { SheetAction as StripAction, SheetBack } from '../ui/PlaceScreen';

import { AppText } from '../AppText';
import { ActionList, Button, Header, Icon, Sheet, type SheetAction } from '../ui';
import { BudgetSheet } from '../BudgetSheet';
import { PageNameSheet } from '../PageNameSheet';
import { Screen } from '../Screen';
import { FindField, SearchMore } from '../SearchResults';
import { EntryList } from './EntryList';
import { resolveView } from './registry';
import { entryRow, shownEntries, sortEntries } from './rows';

/**
 * `PageFrame` (template-screens 3): the same edges on every page so nobody gets lost — one header line
 * (ux-audit P0-2, design-system §3 Header): the title, 🔍 «Найти на странице» (S10, the field opens on
 * tap) and ⋯ with «Порядок», «Переименовать» (custom pages) and «Настроить» (S38).
 * The middle is the template's tool from the registry (`resolveView`); while searching, the frame
 * shows the found records the same way on every page. The bottom edge — answer banner, «Отменить»,
 * the assistant line, tabs — is the main layout's footer, outside the tool.
 */
/** What a page tool puts on the coloured sheet (v5 «Расходы»: month · the big number · the phrase). */
export type SheetSlot = {
  metaNode?: ReactNode;
  sheetExtra?: ReactNode;
  phrase?: string;
  sub?: string;
  hideTitle?: boolean;
  /** A sub-screen of the tool (a category, a receipt): the sheet opens collapsed with its own title and «‹ back». */
  strip?: { title: string; back: SheetBack; actions?: StripAction[] };
};
const SheetSlotContext = createContext<((s: SheetSlot | null) => void) | null>(null);

/**
 * A tool fills its page's sheet. `key` says when it changed (the node itself is new on every render): the sheet is
 * set again only then, and cleared on unmount.
 */
export function useSheetSlot(slot: SheetSlot | null, key: string): void {
  const set = useContext(SheetSlotContext);
  const ref = useRef(slot);
  useEffect(() => {
    ref.current = slot;
  });
  useEffect(() => {
    set?.(ref.current);
  }, [key, set]);
  useEffect(() => () => set?.(null), [set]);
}

/** Neighbour places peeking above the sheet of a tab root (design-system §11.1). */
const PEEK: Partial<Record<PlaceKey, readonly [PlaceKey, PlaceKey]>> = {
  notes: ['expenses', 'today'],
  expenses: ['tasks', 'assistant'],
};

export function PageFrame({ page }: { page: Page }) {
  const [slot, setSlot] = useState<SheetSlot | null>(null);
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { title } = usePageLabels();
  const loaded = usePageEntries(page);
  // Sort by a field (S38 / the assistant): the phone orders the same way the server does.
  const entries = useMemo(
    () => (loaded ? sortEntries(loaded, page.view?.sort ?? null) : null),
    [loaded, page.view?.sort],
  );
  const [renaming, setRenaming] = useState(false);
  // Tabs reuse one screen for all pages: what was typed on page A stays with page A.
  const [find, setFind] = useState({ pageId: page.id, q: '' });
  const q = find.pageId === page.id ? find.q : '';
  const searching = q.trim().length > 0;
  const server = useServerSearch(q, { pageServerId: page.serverId ?? null, enabled: !!page.serverId });
  const highlight = useView((st) => st.highlight);
  const clearHighlight = useView((st) => st.clearHighlight);
  const setVisible = useView((st) => st.setVisible);
  const [ordering, setOrdering] = useState(false);
  // QA v5-device-2 A5: the order mode closes by itself — leaving the screen or the tab, the app going to the
  // background, «Назад», another page in this screen, 60 s without a touch. Every «Выше / Ниже» is saved at once,
  // so «Готово» only closes it and nothing is lost.
  const [orderPage, setOrderPage] = useState(page.id);
  if (orderPage !== page.id) {
    setOrderPage(page.id);
    setOrdering(false);
  }
  useFocusEffect(useCallback(() => () => setOrdering(false), []));
  useEffect(() => {
    if (!ordering) return;
    const app = AppState.addEventListener('change', (st) => {
      if (st !== 'active') setOrdering(false);
    });
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      setOrdering(false);
      return true;
    });
    const idle = setTimeout(() => setOrdering(false), 60_000);
    return () => {
      app.remove();
      back.remove();
      clearTimeout(idle);
    };
  }, [ordering, entries]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const statements = useFeatures((f) => f.statements_pdf);
  const receiptQr = useFeatures((f) => f.receipt_qr);
  const isExpenses = page.templateKey === 'expenses';
  const view = resolveView(page);
  const notesLook = useNotesLook((st) => st.look);
  const setNotesLook = useNotesLook((st) => st.set);
  const isNotes = page.templateKey === 'notes';
  const place = placeOfTemplate(page.templateKey);
  const { from } = useLocalSearchParams<{ from?: string }>();
  const fromMore = from === 'more';
  const shopping = useView((st) => st.shopMode === page.id);

  // The marker goes after 600 ms (Reduce Motion: the same, it is a colour, not a move).
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(clearHighlight, Math.max(0, highlight.until - Date.now()));
    return () => clearTimeout(timer);
  }, [highlight, clearHighlight]);

  // Until the list reports what is visible, the first rows count as on screen.
  useEffect(() => {
    if (!entries) return;
    setVisible(
      page.id,
      entries.map((e) => e.record.serverId).filter((x): x is string => !!x),
    );
  }, [entries, page.id, setVisible]);

  const hasRecords = (entries?.length ?? 0) > 0;
  const searchShown = searchOpen || searching;
  const closeSearch = () => {
    setSearchOpen(false);
    setFind({ pageId: page.id, q: '' });
  };
  const closeMenu = (then: () => void) => () => {
    setMenuOpen(false);
    then();
  };
  const receipt = (kind: 'camera' | 'statement' | 'qr') =>
    router.push({ pathname: '/receipt', params: { kind, page: page.id } });
  // add-entry-model.md «Что в „⋯“»: «Расходы» — the statement (by its switch), the QR, the budget, «Настроить».
  const expenseMenu: SheetAction[] = [
    ...(statements
      ? [
          {
            key: 'statement',
            testID: 'exp-statement',
            label: t('exp.statement_menu'),
            icon: FileText,
            onPress: closeMenu(() => receipt('statement')),
          },
        ]
      : []),
    ...(receiptQr
      ? [
          {
            key: 'qr',
            testID: 'exp-qr',
            label: t('exp.bring_qr'),
            icon: QrCode,
            onPress: closeMenu(() => receipt('qr')),
          },
        ]
      : []),
    {
      key: 'budget',
      testID: 'exp-budget-menu',
      label: t('budget.set'),
      icon: Wallet,
      onPress: closeMenu(() => setBudgetOpen(true)),
    },
  ];
  const menuActions: SheetAction[] = [
    // add-entry-model.md: at most two icons on the sheet, «+» and «⋯»; «Найти на странице» is the first row of «⋯».
    ...(isExpenses
      ? expenseMenu
      : [
          {
            key: 'find',
            testID: 'page-search',
            label: t('page.find'),
            icon: Search,
            onPress: closeMenu(() => router.navigate({ pathname: '/search', params: { page: page.id } })),
          },
        ]),
    // QA B «Заметки» 1: «Сеткой / Списком» lives in «⋯».
    ...(isNotes
      ? [
          {
            key: 'look',
            testID: notesLook === 'list' ? 'notes-look-grid' : 'notes-look-list',
            label: notesLook === 'list' ? t('notes.look_grid') : t('notes.look_list'),
            icon: notesLook === 'list' ? LayoutGrid : List,
            onPress: () => {
              setMenuOpen(false);
              setNotesLook(notesLook === 'list' ? 'grid' : 'list');
            },
          },
        ]
      : []),
    ...(hasRecords && !searching && !isExpenses
      ? [
          {
            key: 'order',
            testID: 'page-order',
            label: t('page.order'),
            icon: ArrowUpDown,
            onPress: () => (setMenuOpen(false), setOrdering(true)),
          },
        ]
      : []),
    ...(page.templateKey === 'custom'
      ? [
          {
            key: 'rename',
            testID: 'page-rename',
            label: t('page.rename'),
            icon: PencilLine,
            onPress: () => (setMenuOpen(false), setRenaming(true)),
          },
        ]
      : []),
    {
      key: 'settings',
      testID: 'page-settings',
      label: t('view.settings'),
      hint: t('view.settings_a11y', { page: title(page) }),
      icon: SlidersHorizontal,
      onPress: () => {
        setMenuOpen(false);
        router.push({ pathname: '/page-settings/[id]', params: { id: page.id } });
      },
    },
  ];
  // add-entry-model.md: the page «+» makes this place's own thing — a note (also on an own page), a task (the reminder
  // form until a task editor exists); «Расходы»: «+ Трата» (the capsule), the receipt camera 📷 and «⋯».
  const add = () => {
    if (page.templateKey === 'tasks') router.push('/reminder-new');
    else router.push({ pathname: '/note-new', params: { page: page.id } });
  };
  const menuIcon: StripAction = {
    key: 'menu',
    testID: 'page-menu',
    icon: Ellipsis,
    label: t('move.menu_a11y', { what: title(page) }),
    onPress: () => setMenuOpen(true),
  };
  const headerActions: StripAction[] = isExpenses
    ? [
        {
          key: 'camera',
          testID: 'exp-camera',
          icon: Camera,
          label: t('exp.camera_a11y'),
          onPress: () => receipt('camera'),
        },
        menuIcon,
      ]
    : searchShown
      ? [
          { key: 'search', testID: 'page-search-close', icon: X, label: t('common.close'), onPress: closeSearch },
          menuIcon,
        ]
      : [
          {
            key: 'add',
            testID: 'page-add',
            icon: Plus,
            label: page.templateKey === 'tasks' ? t('add.task_new') : t('add.note_new'),
            onPress: add,
          },
          menuIcon,
        ];
  const header = (
    <Header
      testID="page-header"
      title={title(page)}
      // «Дела» are not a tab any more (VISION-2026-11): «‹ Сегодня» leads back to where they come from.
      back={
        page.templateKey === 'tasks'
          ? fromMore
            ? { onPress: () => router.navigate('/more'), label: t('more.title'), testID: 'page-back' }
            : { onPress: () => router.navigate('/'), label: t('today.today'), testID: 'page-back' }
          : undefined
      }
      meta={
        isNotes && entries
          ? t(notesLook === 'list' ? 'notes.count_list' : 'notes.count', { count: entries.length })
          : page.templateKey === 'tasks'
            ? todayLine(i18n.language)
            : undefined
      }
      accessory={
        page.templateKey === 'expenses' ? (
          <Button
            testID="exp-enter"
            label={t('exp.add_short')}
            size="small"
            icon={<Icon icon={Plus} size="sm" color="onBrand" />}
            onPress={() => useView.getState().requestKeypad()}
          />
        ) : undefined
      }
      titleTestID="page-title"
      actions={headerActions}
    />
  );
  const top = (
    <View style={{ gap: theme.space[2] }}>
      {searchShown ? (
        <FindField
          testID="page-find"
          label={t('page.find')}
          value={q}
          onChange={(value) => setFind({ pageId: page.id, q: value })}
        />
      ) : null}
      {ordering ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
          <AppText
            testID="page-order-hint"
            variant="callout"
            numberOfLines={1}
            accessibilityLiveRegion="polite"
            style={{ flex: 1 }}
          >
            {t('page.order_hint')}
          </AppText>
          <Button
            testID="page-order"
            label={t('page.order_done')}
            size="small"
            minHeight={42}
            accessibilityState={{ selected: true }}
            onPress={() => setOrdering(false)}
          />
        </View>
      ) : null}
    </View>
  );

  let middle;
  if (searching) {
    const found = searchRecords(
      shownEntries((entries ?? []).map(entryRow)).map((e) => e.record),
      q,
    );
    const known = new Set(found.map((r) => r.serverId));
    const extra = server.results.filter((r) => !known.has(r.hit.item_id));
    const nothing = found.length === 0 && extra.length === 0 && server.state !== 'loading';
    middle = (
      <EntryList
        page={page}
        rows={found.map((record) => entryRow({ record, link: null }))}
        header={<View style={{ marginBottom: theme.space[4] }}>{top}</View>}
        ordering={false}
        searchQuery={q}
        footer={
          <View style={{ gap: theme.space[3] }}>
            <SearchMore rows={extra} state={server.state} pageId={page.id} q={q} />
            {nothing ? (
              <AppText testID="page-find-none" accessibilityLiveRegion="polite">
                {t('page.find_none')}
              </AppText>
            ) : null}
            <Button
              testID="page-find-all"
              label={t('page.find_all')}
              variant="text"
              onPress={() => router.navigate({ pathname: '/search', params: { q } })}
            />
          </View>
        }
      />
    );
  } else {
    const Tool = view.Component;
    middle = <Tool page={page} entries={entries} frameTop={top} ordering={ordering} />;
  }

  return (
    <SheetSlotContext.Provider value={setSlot}>
      <Screen
        testID={`page-${page.templateKey}`}
        place={place}
        peek={PEEK[place]}
        scroll={false}
        askRoom
        phrase={slot?.phrase}
        sub={slot?.sub}
        metaNode={slot?.metaNode}
        sheetExtra={slot?.sheetExtra}
        hideTitle={slot?.hideTitle}
        {...(slot?.strip
          ? {
              mode: 'strip' as const,
              title: slot.strip.title,
              back: slot.strip.back,
              actions: slot.strip.actions ?? [],
            }
          : {})}
      >
        {/* «Я в магазине» is the list alone: no sheet header (template-screens 3). */}
        {shopping ? null : header}
        <View testID={`page-view-${view.key}`} style={{ flex: 1 }}>
          {middle}
        </View>
        {menuOpen ? (
          <Sheet testID="page-menu-sheet" visible onClose={() => setMenuOpen(false)} title={title(page)}>
            <ActionList actions={menuActions} />
          </Sheet>
        ) : null}
        {budgetOpen ? <BudgetSheet visible onClose={() => setBudgetOpen(false)} /> : null}
        {renaming ? (
          <PageNameSheet
            initial={page.title ?? ''}
            onClose={() => setRenaming(false)}
            onSave={(name) => {
              setRenaming(false);
              void renamePage(page.id, name);
            }}
          />
        ) : null}
      </Screen>
    </SheetSlotContext.Provider>
  );
}

/** «суббота, 14 ноября» above the title of «Дела» (QA v2 §4.1). */
function todayLine(lang: string): string {
  try {
    return new Date().toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    return new Date().toDateString();
  }
}
