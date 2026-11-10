import { router } from 'expo-router';
import { ChevronDown, Ellipsis } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View, type AccessibilityActionEvent } from 'react-native';

import type { DocumentOut } from '@/api/types';
import type { LocalRecord } from '@/db/records';
import { useExpenses } from '@/expenses/store';
import { assistantOn, pumpJobs, refreshDocuments, setKpStatus, shownStatus } from '@/kp/service';
import { useKp, type KpJob } from '@/kp/store';
import { decToMinor } from '@/kp/calc';
import { kpTitle, kpView, money, shortDate, statusWord } from '@/kp/view';
import { facetKey, useFacets } from '@/pages/facets';
import type { PageEntry } from '@/pages/contents';
import { recordTitle } from '@/records/format';
import { useOnboarding } from '@/store/onboarding';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../Button';
import { MiniSheet, StatusBar } from '../kp/KpParts';
import { ChoiceSheet } from './FieldSheets';
import { EntryList, type EntryCtx } from './EntryList';
import { Sheet } from './ExpenseParts';
import type { ViewProps } from './registry';
import { entryRow, type EntryRow, type Row } from './rows';

/** The dividers of the card file: a filter by the field «Тип» (template-screens 2.5). */
export type DocType = 'kp' | 'contract' | 'receipt' | 'other';
type Filter = 'all' | DocType;
const FILTERS: Filter[] = ['all', 'kp', 'contract', 'receipt', 'other'];

export type CardInfo = { type: DocType; doc: DocumentOut | null; client: string | null };

/**
 * The type of a record on «Документы и КП»: a КП (its document), a receipt (a spending of
 * «Расходы» has it), the field «Тип» when the server set it, else «другое». Never guessed from the text.
 */
export function cardInfo(
  entry: PageEntry,
  o: { pageId: string; docsByItem: Map<string, DocumentOut>; receiptItems: Set<string>; facets: Record<string, Record<string, unknown>> },
): CardInfo {
  const rec = entry.record;
  const doc = rec.serverId ? o.docsByItem.get(rec.serverId) ?? null : null;
  const field = o.facets[facetKey(o.pageId, rec.id)]?.doc_type;
  const type: DocType = doc || (rec.kind as string) === 'kp'
    ? 'kp'
    : rec.serverId && o.receiptItems.has(rec.serverId)
      ? 'receipt'
      : field === 'contract' || field === 'receipt' || field === 'kp'
        ? field
        : 'other';
  return { type, doc, client: doc?.client_name ?? entry.link?.groupKey ?? null };
}

/** Folders by client (`group_key`), in the order they first appear; «Без клиента» last. */
export function foldersOf(entries: PageEntry[], info: (e: PageEntry) => CardInfo, noClient: string): Row[] {
  const groups = new Map<string, PageEntry[]>();
  for (const e of entries) {
    const key = info(e).client?.trim() || '';
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const keys = [...groups.keys()].sort((a, b) => Number(a === '') - Number(b === ''));
  const out: Row[] = [];
  for (const key of keys) {
    out.push({ type: 'group', key: `folder:${key}`, title: key || noClient });
    out.push(...(groups.get(key) ?? []).map(entryRow));
  }
  return out;
}

/**
 * «Документы и КП» — the card file (template-screens 2.5, week 14). One accent «Новое КП», the
 * dividers [Все | КП 4 | Договоры 2 | Чеки 23 | …] (≥150%: «Показать: Все ▾»), folders by client,
 * a КП with its mini-sheet, sum, date and the status bar (the person sets the step: «Клиент
 * принял?» [Да] [Нет]); a document with its type on the sheet. Everything here works offline and in
 * «Без ИИ»; a new КП needs the assistant and the internet. The shared «⋯ Ещё», «Порядок» and drag stay.
 */
export function DocumentsView({ page, entries, frameTop, ordering }: ViewProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const docs = useKp((s) => s.docs);
  const statusEdits = useKp((s) => s.statusEdits);
  const jobs = useKp((s) => s.jobs);
  const expenses = useExpenses((s) => s.entries);
  const facets = useFacets((s) => s.values);
  const ai = useOnboarding((s) => s.consent?.mode === 'full');
  const [filter, setFilter] = useState<Filter>('all');
  const [choosing, setChoosing] = useState(false);
  const [statusFor, setStatusFor] = useState<string | null>(null);
  const [noAi, setNoAi] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());

  useEffect(() => {
    void refreshDocuments();
    void pumpJobs();
  }, [page.id]);

  const docsByItem = useMemo(() => {
    const m = new Map<string, DocumentOut>();
    for (const d of Object.values(docs)) if (d.item_id && !d.deleted_at) m.set(d.item_id, d);
    return m;
  }, [docs]);
  const receiptItems = useMemo(
    () => new Set(Object.values(expenses).flatMap((e) => (e.item_id && !e.deleted_at ? [e.item_id] : []))),
    [expenses],
  );
  const info = (e: PageEntry) => cardInfo(e, { pageId: page.id, docsByItem, receiptItems, facets });
  const all = entries ?? [];
  const counts: Record<Filter, number> = { all: all.length, kp: 0, contract: 0, receipt: 0, other: 0 };
  for (const e of all) counts[info(e).type] += 1;
  const shown = filter === 'all' ? all : all.filter((e) => info(e).type === filter);
  const rows = foldersOf(shown, info, t('kp.folder_none')).filter(
    (r) => r.type !== 'entry' || !closed.has(`folder:${info(r.entry).client?.trim() || ''}`),
  );

  // КП made on the server whose record is not on this phone yet, and specs still being read.
  const onPage = new Set(all.flatMap((e) => (e.record.serverId ? [e.record.serverId] : [])));
  const loose = Object.values(docs).filter((d) => !d.deleted_at && d.status !== 'extracting' && (!d.item_id || !onPage.has(d.item_id)));
  const working = Object.values(jobs).filter((j) => j.state !== 'done');
  const label = (f: Filter) => t(`kp.filter_${f}`);

  const newKp = () => {
    if (!assistantOn()) return setNoAi(true);
    router.push('/kp/new');
  };

  const header = (
    <View style={{ gap: theme.space[4], marginBottom: theme.space[4] }}>
      {frameTop}
      <Button testID="docs-new-kp" label={ai ? t('kp.new') : t('kp.new_no_ai')} onPress={newKp} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        <Button testID="docs-company" label={t('kp.my_company')} variant="outline" minHeight={theme.size.minTouch} style={{ flexGrow: 1 }} onPress={() => router.push('/company')} />
        <Button testID="docs-prices" label={t('kp.my_prices')} variant="outline" minHeight={theme.size.minTouch} style={{ flexGrow: 1 }} onPress={() => router.push('/price-list')} />
      </View>
      {all.length > 0 ? (
        theme.largeFont ? (
          <Pressable
            testID="docs-filter"
            accessibilityRole="button"
            onPress={() => setChoosing(true)}
            style={{ minHeight: theme.size.minTouch, flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}
          >
            <AppText color="accent">{t('kp.show', { label: label(filter) })}</AppText>
            <ChevronDown size={22} color={theme.colors.accent} />
          </Pressable>
        ) : (
          <View testID="docs-dividers" accessibilityRole="tablist" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
            {FILTERS.filter((f) => f === 'all' || counts[f] > 0).map((f) => (
              <Pressable
                key={f}
                testID={`docs-divider-${f}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: filter === f }}
                accessibilityLabel={t('kp.filter_a11y', { label: label(f), count: counts[f] })}
                onPress={() => setFilter(f)}
                style={{
                  minHeight: theme.size.minTouch,
                  paddingHorizontal: theme.space[3],
                  justifyContent: 'center',
                  borderTopLeftRadius: theme.radius.chip,
                  borderTopRightRadius: theme.radius.chip,
                  borderWidth: filter === f ? 2 : 1,
                  borderBottomWidth: filter === f ? 0 : 1,
                  borderColor: filter === f ? theme.colors.accent : theme.colors.lineStrong,
                  backgroundColor: filter === f ? theme.colors.surface : theme.colors.bg,
                }}
              >
                <AppText color={filter === f ? 'accent' : 'ink'} variant={filter === f ? 'bodyStrong' : 'body'}>
                  {f === 'all' ? label(f) : t('kp.filter_count', { label: label(f), count: counts[f] })}
                </AppText>
              </Pressable>
            ))}
          </View>
        )
      ) : null}
      {working.map((j) => (
        <JobCard key={j.id} job={j} />
      ))}
      {(filter === 'all' || filter === 'kp') && loose.length > 0
        ? loose.map((d) => (
            <KpCard
              key={d.id}
              doc={d}
              testID={`docs-kp-${d.id}`}
              onOpen={() => router.push({ pathname: '/kp/[id]', params: { id: d.id } })}
              onStatus={() => setStatusFor(d.id)}
            />
          ))
        : null}
    </View>
  );

  const renderEntry = (row: EntryRow, ctx: EntryCtx) => {
    const i = info(row.entry);
    if (i.doc) {
      const d = i.doc;
      return (
        <KpCard
          doc={d}
          testID={`docs-kp-${d.id}`}
          highlighted={ctx.highlighted}
          moves={ctx.moves}
          onOpen={() => router.push({ pathname: '/kp/[id]', params: { id: d.id } })}
          onStatus={() => setStatusFor(d.id)}
        />
      );
    }
    return <DocCard record={row.entry.record} type={i.type} client={i.client} ctx={ctx} />;
  };

  const renderGroup = (g: Extract<Row, { type: 'group' }>) => {
    const n = shown.filter((e) => `folder:${info(e).client?.trim() || ''}` === g.key).length;
    const isClosed = closed.has(g.key);
    return (
      <Pressable
        testID={`docs-${g.key}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !isClosed }}
        accessibilityLabel={t('kp.folder_a11y', { name: g.title, count: n })}
        onPress={() =>
          setClosed((s) => {
            const next = new Set(s);
            if (next.has(g.key)) next.delete(g.key);
            else next.add(g.key);
            return next;
          })
        }
        style={{ minHeight: theme.size.minTouch, flexDirection: 'row', alignItems: 'center', gap: theme.space[2], marginTop: theme.space[2], marginBottom: theme.space[2] }}
      >
        <AppText variant="section" accessibilityRole="header" style={{ flex: 1 }}>
          {t('kp.folder', { name: g.title })}
        </AppText>
        <AppText variant="number">{`${n} ${isClosed ? '›' : '⌄'}`}</AppText>
      </Pressable>
    );
  };

  const menuExtra = (rec: LocalRecord) => {
    const d = rec.serverId ? docsByItem.get(rec.serverId) : undefined;
    if (!d) return [];
    return [
      { testID: 'menu-kp-open', label: t('kp.open'), onPress: () => router.push({ pathname: '/kp/[id]', params: { id: d.id } }) },
      { testID: 'menu-kp-status', label: t('kp.status_title'), onPress: () => setStatusFor(d.id) },
    ];
  };

  const empty =
    entries && working.length === 0 && loose.length === 0 ? (
      <View testID="docs-empty" style={{ gap: theme.space[3], padding: theme.space[4], borderWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.lineStrong, borderRadius: theme.radius.card }}>
        <AppText variant="title2">{t('kp.empty_title')}</AppText>
        <AppText>{t('kp.empty_body')}</AppText>
      </View>
    ) : null;

  const statusDoc = statusFor ? docs[statusFor] : undefined;

  return (
    <>
      <EntryList
        page={page}
        rows={ordering ? all.map(entryRow) : rows}
        header={header}
        ordering={ordering}
        renderEntry={ordering ? undefined : renderEntry}
        renderGroup={renderGroup}
        menuExtra={menuExtra}
        empty={empty}
      />
      {choosing ? (
        <ChoiceSheet
          testID="docs-filter-sheet"
          title={t('kp.show', { label: label(filter) })}
          options={FILTERS.filter((f) => f === 'all' || counts[f] > 0).map((f) => ({ key: f, label: f === 'all' ? label(f) : t('kp.filter_count', { label: label(f), count: counts[f] }) }))}
          value={filter}
          onPick={(k) => {
            setFilter(k as Filter);
            setChoosing(false);
          }}
          onClose={() => setChoosing(false)}
        />
      ) : null}
      {statusDoc ? (
        <Sheet testID="kp-status-sheet" title={t('kp.status_title')} onClose={() => setStatusFor(null)}>
          <AppText variant="meta">{kpTitle(statusDoc, t)}</AppText>
          <Button
            testID="kp-status-seen"
            label={t('kp.status_seen')}
            variant="outline"
            onPress={() => {
              setStatusFor(null);
              void setKpStatus(statusDoc.id, 'seen');
            }}
          />
          <Button
            testID="kp-status-yes"
            label={t('kp.status_yes')}
            onPress={() => {
              setStatusFor(null);
              void setKpStatus(statusDoc.id, 'accepted');
            }}
          />
          <Button
            testID="kp-status-no"
            label={t('kp.status_no')}
            variant="outline"
            onPress={() => {
              setStatusFor(null);
              void setKpStatus(statusDoc.id, 'declined');
            }}
          />
          {shownStatus(statusDoc, statusEdits) !== 'draft' ? (
            <Button
              testID="kp-status-back"
              label={t('kp.status_back')}
              variant="text"
              onPress={() => {
                setStatusFor(null);
                void setKpStatus(statusDoc.id, 'draft');
              }}
            />
          ) : null}
        </Sheet>
      ) : null}
      {noAi ? (
        <Sheet testID="kp-no-ai" title={t('kp.no_ai_title')} onClose={() => setNoAi(false)}>
          <AppText>{t('kp.no_ai_body')}</AppText>
          <Button testID="kp-no-ai-company" label={t('kp.my_company')} variant="outline" onPress={() => { setNoAi(false); router.push('/company'); }} />
          <Button testID="kp-no-ai-prices" label={t('kp.my_prices')} variant="outline" onPress={() => { setNoAi(false); router.push('/price-list'); }} />
        </Sheet>
      ) : null}
    </>
  );
}

/** A КП in the card file: the mini-sheet, «КП № 17», the sum and the day, the status bar, «⋯». */
function KpCard({
  doc,
  onOpen,
  onStatus,
  testID,
  highlighted = false,
  moves,
}: {
  doc: DocumentOut;
  onOpen: () => void;
  onStatus: () => void;
  testID: string;
  highlighted?: boolean;
  moves?: EntryCtx['moves'];
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const status = useKp((s) => s.statusEdits[doc.id]?.status ?? doc.deal_status);
  const edit = useKp((s) => s.docEdits[doc.id]);
  const version = useKp((s) => s.versions[doc.id]);
  // A tap-edit still on its way: the total as the phone counts it; else the server's.
  const local = edit ? kpView(edit.data, version, true).totals : null;
  const total = local ? local.total : doc.total ? decToMinor(doc.total) : null;
  const title = kpTitle(doc, t);
  const amount = total !== null && (doc.missing_prices === 0 || local) ? money(total) : '';
  const date = shortDate(doc.date ?? doc.created_at, i18n.language);
  const word = statusWord(status, t);
  const actions = moves
    ? [...(moves.onUp ? [{ name: 'up', label: t('move.up') }] : []), ...(moves.onDown ? [{ name: 'down', label: t('move.down') }] : []), { name: 'menu', label: t('move.menu') }]
    : undefined;
  const onAction = (e: AccessibilityActionEvent) => {
    const n = e.nativeEvent.actionName;
    if (n === 'up') moves?.onUp?.();
    else if (n === 'down') moves?.onDown?.();
    else if (n === 'menu') moves?.onMenu();
  };
  return (
    <View
      testID={testID}
      style={{ borderWidth: 1, borderColor: theme.colors.line, borderRadius: theme.radius.card, backgroundColor: highlighted ? theme.colors.markerSoft : theme.colors.surface, padding: theme.space[3], marginBottom: theme.space[3], gap: theme.space[2] }}
    >
      <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
        <Pressable
          testID={`${testID}-open`}
          accessibilityRole="button"
          accessibilityLabel={t('kp.kp_a11y', { title, amount, date, status: word })}
          accessibilityActions={actions}
          onAccessibilityAction={actions ? onAction : undefined}
          onPress={onOpen}
          onLongPress={moves?.onDragStart}
          delayLongPress={400}
          style={{ flex: 1, flexDirection: 'row', gap: theme.space[3], minHeight: theme.size.primaryTouch }}
        >
          {theme.largeFont ? null : <MiniSheet type={t('kp.type_kp')} />}
          <View style={{ flex: 1, gap: theme.space[1] }}>
            <AppText variant="bodyStrong">{theme.largeFont ? `${t('kp.type_kp')} · ${title}` : title}</AppText>
            <AppText variant="number">{[amount, date].filter(Boolean).join(' · ')}</AppText>
          </View>
        </Pressable>
        {moves ? (
          <Pressable
            testID={`${testID}-menu`}
            accessibilityRole="button"
            accessibilityLabel={t('move.menu_a11y', { what: title })}
            onPress={moves.onMenu}
            style={{ width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' }}
          >
            <Ellipsis size={24} color={theme.colors.accent} />
          </Pressable>
        ) : null}
      </View>
      <StatusBar testID={`${testID}-status`} status={status} word={word} onPress={onStatus} />
    </View>
  );
}

/** A document: the type in a word on its sheet, the title, «Арман · 1 окт»; opens S09. */
function DocCard({ record, type, client, ctx }: { record: LocalRecord; type: DocType; client: string | null; ctx: EntryCtx }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const typeWord =
    type === 'receipt' ? t('kp.type_receipt') : type === 'contract' ? t('kp.type_contract') : record.kind === 'pdf' ? t('kp.type_pdf') : record.kind === 'image' || record.kind === 'screenshot' ? t('kp.type_photo') : t('kp.type_doc');
  const title = recordTitle(record, t);
  const meta = [client, shortDate(record.occurredAt, i18n.language)].filter(Boolean).join(' · ');
  const moves = ctx.moves;
  const actions = moves
    ? [...(moves.onUp ? [{ name: 'up', label: t('move.up') }] : []), ...(moves.onDown ? [{ name: 'down', label: t('move.down') }] : []), ...(moves.onMoveTo ? [{ name: 'moveTo', label: t('move.to') }] : []), { name: 'menu', label: t('move.menu') }]
    : undefined;
  const onAction = (e: AccessibilityActionEvent) => {
    const n = e.nativeEvent.actionName;
    if (n === 'up') moves?.onUp?.();
    else if (n === 'down') moves?.onDown?.();
    else if (n === 'moveTo') moves?.onMoveTo?.();
    else if (n === 'menu') moves?.onMenu();
  };
  return (
    <View
      testID={`docs-doc-${record.id}`}
      onLayout={ctx.onLayout}
      style={{ flexDirection: 'row', borderWidth: 1, borderColor: ctx.lifted ? theme.colors.accent : theme.colors.line, borderRadius: theme.radius.card, backgroundColor: ctx.highlighted ? theme.colors.markerSoft : theme.colors.surface, padding: theme.space[3], marginBottom: theme.space[3], gap: theme.space[3] }}
    >
      <Pressable
        testID={`record-${record.id}`}
        accessibilityRole="button"
        accessibilityLabel={t('kp.doc_a11y', { type: typeWord, title, meta })}
        accessibilityActions={actions}
        onAccessibilityAction={actions ? onAction : undefined}
        onPress={ctx.onPress}
        onLongPress={moves?.onDragStart}
        delayLongPress={400}
        style={{ flex: 1, flexDirection: 'row', gap: theme.space[3], minHeight: theme.size.primaryTouch }}
      >
        {theme.largeFont ? null : <MiniSheet type={typeWord} />}
        <View style={{ flex: 1, gap: theme.space[1] }}>
          <AppText numberOfLines={3}>{theme.largeFont ? `${typeWord} · ${title}` : title}</AppText>
          {meta ? <AppText variant="meta">{meta}</AppText> : null}
        </View>
      </Pressable>
      {moves ? (
        <Pressable
          testID={`record-menu-${record.id}`}
          accessibilityRole="button"
          accessibilityLabel={t('move.menu_a11y', { what: title })}
          onPress={moves.onMenu}
          style={{ width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ellipsis size={24} color={theme.colors.accent} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A spec being read: «Читаю ТЗ…» / «ТЗ сохранено. Прочитаю, когда появится интернет» / failed. */
export function JobCard({ job }: { job: KpJob }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const doc = useKp((s) => (job.documentId ? s.docs[job.documentId] : undefined));
  const p = doc?.progress;
  const text =
    job.state === 'failed'
      ? job.message ?? t('kp.job_failed')
      : job.state === 'reading'
        ? p && p.total > 0
          ? t('kp.job_progress', { done: p.done, total: p.total })
          : t('kp.job_reading')
        : t('kp.job_waiting');
  return (
    <Pressable
      testID={`kp-job-${job.id}`}
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/kp/new', params: { job: job.id } })}
      style={{ minHeight: theme.size.primaryTouch, padding: theme.space[3], borderWidth: 1, borderStyle: 'dashed', borderColor: theme.colors.lineStrong, borderRadius: theme.radius.card, justifyContent: 'center' }}
    >
      <AppText testID={`kp-job-${job.id}-text`} accessibilityLiveRegion="polite" color={job.state === 'failed' ? 'warnText' : 'ink'}>
        {text}
      </AppText>
    </Pressable>
  );
}
