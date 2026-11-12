import { Check, ChevronDown, Ellipsis } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { CustomFieldType } from '@/api/types';
import type { LocalRecord } from '@/db';
import type { PageEntry } from '@/pages/contents';
import { catalogTemplate, fieldTitle, MAX_CUSTOM_FIELDS, useCatalog } from '@/pages/catalog';
import { DONE_FIELD, facetKey, formatMoney, moneyToMinor, useFacets, type FieldValue } from '@/pages/facets';
import type { Layout } from '@/pages/templates';
import { fieldsOf, newFieldId, liveCustom, type ShownField } from '@/pages/viewModel';
import { changeView, layoutLabel, setFieldValues } from '@/pages/viewService';
import { formatShortDate, recordTitle } from '@/records/format';
import { useTheme } from '@/theme';
import { newId } from '@/utils/id';

import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import type { RowMoves } from '../RecordRow';
import { EntryList, type EntryCtx } from './EntryList';
import { AddFieldSheet, ChoiceSheet, FieldValueSheet } from './FieldSheets';
import { PageEmpty } from './PageEmpty';
import { entryRow, withGroups, type Row } from './rows';
import type { ViewProps } from './registry';

const MODES: Layout[] = ['list', 'checklist', 'table'];

/**
 * «Своя страница» — a notebook the person rules themselves (template-screens 2.6): [Список |
 * Чек-лист | Таблица] right on the page (each switch is a view change with «Отменить»); an own
 * field is a column; a tap on a cell edits that field in a sheet; «+ Колонка» = «+ Своё поле» (≤5);
 * «Итого» under a «Сумма ₸» column is counted by code. At a large font (≥150%) the table becomes
 * cards, one field per line, no sideways scrolling anywhere, and the switch is a «Вид ▾» list.
 * Works offline and in «Без ИИ»: everything here is by hand.
 */
export function NotebookView({ page, entries, frameTop, ordering }: ViewProps) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const server = useCatalog((s) => s.server);
  const values = useFacets((s) => s.values);
  const [editing, setEditing] = useState<{ record: LocalRecord; field: ShownField } | null>(null);
  const [adding, setAdding] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const mode: Layout = MODES.includes(page.layout) ? page.layout : 'list';
  const tpl = catalogTemplate(page.templateKey, server);
  const fields = useMemo(() => fieldsOf(tpl, page.view).filter((f) => f.visible), [tpl, page.view]);
  const own = fields.filter((f) => f.custom);
  const showText = fields.some((f) => f.id === 'text');
  const showDate = fields.some((f) => f.id === 'date');
  // «Группировка: по полю» (S38): a heading per value, «Без значения» last; else the page's groups.
  const groupBy = page.view?.groupBy ?? null;
  const groupField = groupBy ? fieldsOf(tpl, page.view).find((f) => f.id === groupBy) : undefined;
  const rows = useMemo((): Row[] => {
    if (!groupField) return withGroups(entries ?? [], page.groups ?? []);
    const none = t('view.group_empty');
    const label = (e: PageEntry): string => {
      if (groupField.id === 'date') return formatShortDate(e.record.occurredAt, i18n.language) || none;
      const v = values[facetKey(page.id, e.record.id)]?.[groupField.id];
      if (v === null || v === undefined || v === '') return none;
      return typeof v === 'boolean' ? (v ? t('common.yes') : t('view.no')) : String(v);
    };
    const byLabel = new Map<string, PageEntry[]>();
    for (const e of entries ?? []) byLabel.set(label(e), [...(byLabel.get(label(e)) ?? []), e]);
    const keys = [...byLabel.keys()].sort((x, y) => (x === none ? 1 : y === none ? -1 : 0));
    return keys.flatMap((k): Row[] => [{ type: 'group', key: `by:${k}`, title: k }, ...(byLabel.get(k) ?? []).map(entryRow)]);
  }, [entries, page.groups, page.id, groupField, values, t, i18n.language]);
  const cards = theme.largeFont;
  const canAdd = liveCustom(page.view).length < MAX_CUSTOM_FIELDS;
  const valueOf = (rec: LocalRecord, id: string): FieldValue => values[facetKey(page.id, rec.id)]?.[id] ?? null;
  const show = (f: ShownField, v: FieldValue): string => {
    if (v === null || v === '') return '—';
    if (f.type === 'money') {
      const m = moneyToMinor(v);
      return m === null ? String(v) : formatMoney(m);
    }
    if (f.type === 'bool') return v ? t('common.yes') : t('view.no');
    return String(v);
  };

  // «Итого» per «Сумма ₸» column: code, never the assistant (template-screens 2.6, R-59).
  const totals = own
    .filter((f) => f.type === 'money')
    .map((f) => ({
      f,
      sum: (entries ?? []).reduce((n, e) => n + (moneyToMinor(valueOf(e.record, f.id)) ?? 0), 0),
    }));

  const switcher = cards ? (
    <Button
      testID="notebook-mode-menu"
      label={`${t('view.view')}: ${t(`view.layout.${layoutLabel('custom', mode)}`)}`}
      accessibilityLabel={t('view.view_a11y', { view: t(`view.layout.${layoutLabel('custom', mode)}`) })}
      variant="secondary"
      icon={<ChevronDown size={22} color={theme.colors.brand} />}
      onPress={() => setChoosing(true)}
    />
  ) : (
    <View accessibilityRole="tablist" style={[styles.row, { gap: theme.space[2] }]}>
      {MODES.map((m) => (
        <Button
          key={m}
          testID={`notebook-mode-${m}`}
          label={t(`view.layout.${layoutLabel('custom', m)}`)}
          variant={m === mode ? 'primary' : 'secondary'}
          minHeight={theme.size.minTouch}
          accessibilityRole="tab"
          accessibilityState={{ selected: m === mode }}
          style={styles.flex}
          onPress={() => void changeView(page, { kind: 'layout', layout: m })}
        />
      ))}
    </View>
  );

  const tableHead =
    mode === 'table' && !cards && (entries?.length ?? 0) > 0 ? (
      <View testID="notebook-table-head" accessibilityRole="header" style={[styles.row, styles.cellRow, { borderColor: theme.colors.iconSecondary, backgroundColor: theme.colors.bg }]}>
        {fields
          .filter((f) => f.type !== 'long_text')
          .map((f) => (
            <AppText key={f.id} variant="callout" color="ink" style={[styles.cell, { padding: theme.space[2] }]}>
              {fieldTitle(f, i18n.language)}
            </AppText>
          ))}
        <View style={{ width: theme.size.minTouch }} />
      </View>
    ) : null;

  const header = (
    <View style={{ marginBottom: theme.space[4], gap: theme.space[4] }}>
      {frameTop}
      {switcher}
      {tableHead}
    </View>
  );

  const addButton =
    mode === 'table' ? (
      <View style={{ gap: theme.space[1], marginTop: theme.space[3] }}>
        <Button
          testID="notebook-add-column"
          label={t('view.add_column')}
          variant="secondary"
          disabled={!canAdd}
          onPress={() => setAdding(true)}
        />
        {!canAdd ? <AppText variant="callout">{t('view.err_custom_limit')}</AppText> : null}
      </View>
    ) : null;

  const footer = (
    <View>
      {totals.length > 0 && (entries?.length ?? 0) > 0 ? (
        <View testID="notebook-totals" style={{ gap: theme.space[1], paddingTop: theme.space[2] }}>
          {totals.map(({ f, sum }) => (
            <AppText key={f.id} testID={`notebook-total-${f.id}`} variant="bodyStrong">
              {t('view.total', { field: fieldTitle(f, i18n.language), sum: formatMoney(sum) })}
            </AppText>
          ))}
        </View>
      ) : null}
      {addButton}
    </View>
  );

  const ownLine = (rec: LocalRecord) =>
    own
      .map((f) => ({ f, v: valueOf(rec, f.id) }))
      .filter((x) => x.v !== null && x.v !== '')
      .map((x) => `${fieldTitle(x.f, i18n.language)}: ${show(x.f, x.v)}`)
      .join(' · ');

  const renderEntry = (row: { entry: { record: LocalRecord } }, ctx: EntryCtx) => {
    const rec = row.entry.record;
    const title = recordTitle(rec, t);
    const done = valueOf(rec, DONE_FIELD) === true;
    const date = showDate ? formatShortDate(rec.occurredAt, i18n.language) : '';
    const text = showText && rec.text && rec.text.trim() !== title ? rec.text.trim() : '';
    const box = (
      <Pressable
        testID={`notebook-check-${rec.id}`}
        accessibilityRole="checkbox"
        accessibilityLabel={title}
        accessibilityState={{ checked: done }}
        onPress={() => void setFieldValues(page, rec.id, { [DONE_FIELD]: !done }, t(done ? 'view.unticked' : 'view.ticked', { what: title }))}
        style={{ width: theme.size.buttonHeight, minHeight: theme.size.buttonHeight, alignItems: 'center', justifyContent: 'center' }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            borderWidth: 2,
            borderColor: done ? theme.colors.ink2 : theme.colors.brand,
            backgroundColor: done ? theme.colors.separator : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {done ? <Check size={28} color={theme.colors.ink} /> : null}
        </View>
      </Pressable>
    );
    const cell = (f: ShownField) => {
      const isOwn = f.custom;
      const v = isOwn ? valueOf(rec, f.id) : null;
      const label = isOwn ? show(f, v) : f.id === 'title' ? title : f.id === 'date' ? formatShortDate(rec.occurredAt, i18n.language) : '';
      return (
        <Pressable
          key={f.id}
          testID={`notebook-cell-${rec.id}-${f.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${fieldTitle(f, i18n.language)}: ${label}`}
          accessibilityHint={isOwn ? t('view.edit_hint') : undefined}
          onPress={() => (isOwn ? setEditing({ record: rec, field: f }) : ctx.onPress())}
          style={[styles.cell, { minHeight: theme.size.minTouch, padding: theme.space[2], justifyContent: 'center' }]}
        >
          <AppText color={label === '—' ? 'ink2' : 'ink'}>{label}</AppText>
        </Pressable>
      );
    };

    if (mode === 'table' && !cards) {
      return (
        <View
          testID={`notebook-row-${rec.id}`}
          onLayout={ctx.onLayout}
          style={[styles.row, styles.cellRow, { borderColor: theme.colors.separator, backgroundColor: ctx.highlighted ? theme.colors.highlightTint : theme.colors.surface }]}
        >
          {fields.filter((f) => f.type !== 'long_text').map(cell)}
          <MenuButton rec={rec} title={title} moves={ctx.moves} />
        </View>
      );
    }

    // List, checklist, and the table as cards at a large font: one field per line.
    return (
      <View
        testID={`notebook-card-${rec.id}`}
        onLayout={ctx.onLayout}
        style={[
          styles.card,
          {
            backgroundColor: ctx.highlighted ? theme.colors.highlightTint : theme.colors.surface,
            borderColor: ctx.lifted ? theme.colors.brand : theme.colors.separator,
            borderRadius: theme.radius.lg,
            marginBottom: theme.space[3],
          },
        ]}
      >
        {mode === 'checklist' ? box : null}
        <View style={[styles.flex, { padding: theme.space[3], gap: theme.space[1] }]}>
          <Pressable
            testID={`record-${rec.id}`}
            accessibilityRole="button"
            accessibilityLabel={[title, mode !== 'table' ? ownLine(rec) : '', date].filter(Boolean).join('. ')}
            accessibilityHint={ctx.moves?.onDragStart ? t('move.drag_hint') : undefined}
            onPress={ctx.onPress}
            onLongPress={ctx.moves?.onDragStart}
            delayLongPress={400}
            style={{ minHeight: theme.size.minTouch, justifyContent: 'center', gap: theme.space[1] }}
          >
            <AppText
              variant={mode === 'table' ? 'bodyStrong' : 'body'}
              color={done && mode === 'checklist' ? 'ink2' : 'ink'}
              style={done && mode === 'checklist' ? { textDecorationLine: 'line-through' } : undefined}
            >
              {title}
            </AppText>
            {text && mode !== 'table' ? (
              <AppText variant="callout" numberOfLines={3}>
                {text}
              </AppText>
            ) : null}
            {mode !== 'table' && ownLine(rec) ? <AppText variant="callout">{ownLine(rec)}</AppText> : null}
            {date && mode !== 'table' ? <AppText variant="callout">{date}</AppText> : null}
          </Pressable>
          {mode === 'table' ? fields.filter((f) => f.id !== 'title' && f.type !== 'long_text').map(cell) : null}
        </View>
        <MenuButton rec={rec} title={title} moves={ctx.moves} />
      </View>
    );
  };

  const empty = entries ? (
    <PageEmpty title={t('notebook.empty_title')} lines={[t('notebook.empty'), t('notebook.example_1'), t('notebook.example_2'), t('notebook.example_3')]} />
  ) : null;

  return (
    <>
      <EntryList page={page} rows={rows} header={header} footer={footer} empty={empty} ordering={ordering} renderEntry={renderEntry} />
      {editing ? (
        <FieldValueSheet
          title={fieldTitle(editing.field, i18n.language)}
          type={editing.field.type as CustomFieldType}
          value={valueOf(editing.record, editing.field.id)}
          onClose={() => setEditing(null)}
          onSave={(v) => {
            const e = editing;
            setEditing(null);
            void setFieldValues(page, e.record.id, { [e.field.id]: v }, t('view.value_set', { field: fieldTitle(e.field, i18n.language) }));
          }}
        />
      ) : null}
      {adding ? (
        <AddFieldSheet
          onClose={() => setAdding(false)}
          onAdd={(title, type) => {
            setAdding(false);
            void changeView(page, { kind: 'custom_add', field: { id: newFieldId(newId()), title, type } });
          }}
        />
      ) : null}
      {choosing ? (
        <ChoiceSheet
          testID="notebook-mode-sheet"
          title={t('view.view')}
          value={mode}
          options={MODES.map((m) => ({ key: m, label: t(`view.layout.${layoutLabel('custom', m)}`) }))}
          onClose={() => setChoosing(false)}
          onPick={(m) => {
            setChoosing(false);
            void changeView(page, { kind: 'layout', layout: m as Layout });
          }}
        />
      ) : null}
    </>
  );
}

/** The visible «⋯ Ещё» (48 pt) and, in «Порядок», ↑ ↓ — the same as on every page. */
function MenuButton({ rec, title, moves }: { rec: LocalRecord; title: string; moves: RowMoves | undefined }) {
  const theme = useTheme();
  const { t } = useTranslation();
  if (!moves) return null;
  const square = { width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' } as const;
  return (
    <View style={{ alignItems: 'center', paddingTop: theme.space[1] }}>
      <Pressable testID={`record-menu-${rec.id}`} accessibilityRole="button" accessibilityLabel={t('move.menu_a11y', { what: title })} onPress={moves.onMenu} style={square}>
        <Ellipsis size={24} color={theme.colors.brand} />
      </Pressable>
      {moves.showArrows ? (
        <>
          <Button
            testID={`record-up-${rec.id}`}
            label="↑"
            accessibilityLabel={t('move.up_a11y', { what: title })}
            variant="text"
            minHeight={theme.size.minTouch}
            disabled={!moves.onUp}
            onPress={moves.onUp}
          />
          <Button
            testID={`record-down-${rec.id}`}
            label="↓"
            accessibilityLabel={t('move.down_a11y', { what: title })}
            variant="text"
            minHeight={theme.size.minTouch}
            disabled={!moves.onDown}
            onPress={moves.onDown}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch' },
  flex: { flex: 1 },
  card: { borderWidth: 1, flexDirection: 'row' },
  cellRow: { borderWidth: 1, borderTopWidth: 0 },
  cell: { flex: 1, minWidth: 0 },
});
