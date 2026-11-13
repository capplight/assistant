import { router, useLocalSearchParams } from 'expo-router';
import { ArrowDown, ArrowUp, Check, Lock } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/AppText';
import { PageIcon } from '@/components/Icon';
import { AddFieldSheet, ChoiceSheet } from '@/components/page/FieldSheets';
import { effectiveLayout, hasTool } from '@/components/page/registry';
import { Button, Card, CheckMark, Header, Icon, ListGroup, ListRow, SegmentedControl, Sheet } from '@/components/ui';
import { StandaloneUndoStrip } from '@/components/UndoStrip';
import { catalogTemplate, fieldTitle, MAX_CUSTOM_FIELDS, useCatalog } from '@/pages/catalog';
import { facetKey, useFacets } from '@/pages/facets';
import { renamePage } from '@/pages/service';
import { TEMPLATE_DEFAULT_TITLE, type IconKey, type Layout } from '@/pages/templates';
import { usePageLabels } from '@/pages/usePageLabels';
import { fieldsOf, newFieldId, groupable, liveCustom, type ShownField } from '@/pages/viewModel';
import { changeView, layoutLabel } from '@/pages/viewService';
import { formatShortDate, recordTitle } from '@/records/format';
import { usePageEntries } from '@/records/useRecords';
import { getApi, syncBlocked } from '@/services';
import { useFeatures } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { MAX_FONT_SCALE, readableColumn, useLayout, useTheme, withAlpha } from '@/theme';
import { newId } from '@/utils/id';

const ICONS: IconKey[] = ['home', 'money', 'documents', 'shopping', 'health', 'people', 'work', 'other'];
const SORTS = ['position', 'newest', 'oldest', 'title'] as const;

/**
 * S38 «Настроить страницу». Ф-40: for the beta only the name, the icon and the view (`page_settings_full` off).
 * With the switch on, the full screen comes back (2-design 4.6, template-screens 2.8): the live example, fields
 * with ★ locked, «+ Своё поле» (≤5), sort and grouping, «Вернуть как было» through S25 with «Нет» first.
 * Every change applies at once, offline too, with «Отменить» in the strip at the bottom; «‹ Назад» only closes.
 * What the person sets here is theirs: the assistant changes it only after their «Да».
 */
export default function PageSettingsScreen() {
  const theme = useTheme();
  const layoutInfo = useLayout();
  const { t, i18n } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const page = usePages((s) => s.pages.find((p) => p.id === id));
  const server = useCatalog((s) => s.server);
  const values = useFacets((s) => s.values);
  const entries = usePageEntries(page);
  const full = useFeatures((f) => f.page_settings_full);
  const boardOn = useFeatures((f) => f.board);
  const { title } = usePageLabels();
  const [name, setName] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sheet, setSheet] = useState<'sort' | 'group' | 'reset' | null>(null);

  // The catalogue once per open, when the server can be asked (offline: the local copy).
  useEffect(() => {
    if (useOnboarding.getState().consent === null || syncBlocked()) return;
    void getApi()
      .pageTemplates()
      .then((list) => useCatalog.getState().put(list))
      .catch(() => undefined);
  }, []);

  const close = () => (router.canGoBack() ? router.back() : router.replace(page ? { pathname: '/page/[id]', params: { id: page.id } } : '/'));
  const pad = { paddingHorizontal: layoutInfo.gutter };

  if (!page) {
    return (
      <SafeAreaView testID="page-settings-missing" style={[styles.root, pad, { backgroundColor: theme.colors.bg }]}>
        <Header title={t('page.not_found')} back={{ onPress: close, testID: 'settings-back' }} />
      </SafeAreaView>
    );
  }

  const tpl = catalogTemplate(page.templateKey, server);
  const fields = fieldsOf(tpl, page.view);
  const listed = fields;
  const ownCount = liveCustom(page.view).length;
  const layout = effectiveLayout(page);
  const sample = entries?.[0]?.record ?? null;
  const fname = (f: ShownField) => fieldTitle(f, i18n.language);
  const typeName = (f: ShownField) => (f.custom ? t(`view.type.${f.type}`) : '');
  const currentName = name ?? title(page);
  const saveName = () => {
    if (name === null) return;
    const clean = name.trim();
    if (clean !== title(page)) void renamePage(page.id, clean === TEMPLATE_DEFAULT_TITLE[page.templateKey] ? '' : clean);
    setName(null);
  };
  const exampleValue = (f: ShownField) => {
    if (!sample) return '—';
    if (f.custom) {
      const v = values[facetKey(page.id, sample.id)]?.[f.id];
      return v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? t('common.yes') : t('view.no')) : String(v);
    }
    if (f.id === 'title' || f.id === 'name' || f.id === 'what') return recordTitle(sample, t);
    if (f.id === 'text') return sample.text?.trim() || '—';
    if (f.id === 'date') return formatShortDate(sample.occurredAt, i18n.language);
    return '—';
  };
  const groupOptions = [
    { key: '', label: t('view.group_none') },
    ...fields.filter((f) => f.visible && groupable(f)).map((f) => ({ key: f.id, label: fname(f) })),
  ];
  const layouts = tpl.layouts.filter((l) => l === layout || hasTool(page.templateKey, l, tpl.defaultLayout));
  const square = { width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' } as const;
  const iconD = theme.size.minTouch;

  return (
    <SafeAreaView testID="page-settings" edges={['top']} style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <ScrollView
        contentContainerStyle={[pad, { paddingTop: theme.space[2], paddingBottom: theme.space[8] }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[readableColumn(layoutInfo.contentMaxWidth), { gap: theme.space[5] }]}>
          <Header title={t('view.settings')} back={{ onPress: close, testID: 'settings-back' }} />

          {full ? (
            <Section title={t('view.example')}>
              <Card
                testID="settings-example"
                accessibilityLabel={listed
                  .filter((f) => f.visible)
                  .map((f) => `${fname(f)}: ${exampleValue(f)}`)
                  .join('. ')}
                style={{ gap: theme.space[1] }}
              >
                {listed
                  .filter((f) => f.visible)
                  .map((f, i) => (
                    <AppText key={f.id} testID={`settings-example-${f.id}`} variant={i === 0 ? 'bodyStrong' : 'callout'} color="ink">
                      {i === 0 ? exampleValue(f) : `${fname(f)}: ${exampleValue(f)}`}
                    </AppText>
                  ))}
              </Card>
            </Section>
          ) : null}

          <Section title={t('view.name')}>
            <TextInput
              testID="settings-name"
              accessibilityLabel={t('view.name')}
              value={currentName}
              onChangeText={setName}
              onBlur={saveName}
              onSubmitEditing={saveName}
              maxLength={60}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={[
                theme.type.body,
                {
                  minHeight: theme.size.buttonHeight,
                  borderRadius: theme.radius.md,
                  paddingHorizontal: theme.space[4],
                  color: theme.colors.ink,
                  backgroundColor: theme.colors.surfaceSunken,
                },
              ]}
            />
          </Section>

          <Section title={t('view.icon')}>
            <View accessibilityRole="radiogroup" style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
              {ICONS.map((k) => {
                const on = page.icon === k;
                return (
                  <Pressable
                    key={k}
                    testID={`settings-icon-${k}`}
                    accessibilityRole="radio"
                    accessibilityLabel={t(`view.icons.${k}`)}
                    accessibilityState={{ checked: on }}
                    onPress={() => void changeView(page, { kind: 'icon', icon: k })}
                    style={({ pressed }) => [
                      styles.center,
                      {
                        width: iconD,
                        height: iconD,
                        borderRadius: iconD / 2,
                        backgroundColor: on ? theme.colors.brandTint : pressed ? theme.colors.surfaceSunken : theme.colors.surface,
                      },
                      on ? null : theme.elevation.card,
                    ]}
                  >
                    <PageIcon name={k} size={24} color={on ? theme.colors.brand : theme.colors.ink2} />
                  </Pressable>
                );
              })}
            </View>
          </Section>

          <Section title={t('view.view')}>
            <Card padded={false} style={styles.clip}>
              <View accessibilityRole="radiogroup">
                {layouts.map((l: Layout, i) => {
                  const on = layout === l;
                  return (
                    <Pressable
                      key={l}
                      testID={`settings-layout-${l}`}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      onPress={() => void changeView(page, { kind: 'layout', layout: l })}
                      style={({ pressed }) => [
                        styles.row,
                        {
                          minHeight: theme.size.rowHeight,
                          paddingHorizontal: theme.space[4],
                          paddingVertical: theme.space[2],
                          gap: theme.space[3],
                          backgroundColor: pressed ? withAlpha(theme.colors.surfaceSunken, 0.5) : 'transparent',
                        },
                      ]}
                    >
                      <View style={styles.flex}>
                        <AppText color="ink" style={on ? { fontFamily: theme.type.headline.fontFamily } : undefined}>
                          {t(`view.layout.${layoutLabel(page.templateKey, l)}`)}
                        </AppText>
                        {l === 'list' && page.templateKey !== 'custom' ? <AppText variant="footnote">{t('view.simple_hint')}</AppText> : null}
                      </View>
                      {on ? <Icon icon={Check} color="brand" /> : null}
                      {i < layouts.length - 1 ? (
                        <View style={[styles.divider, { left: theme.space[4], backgroundColor: theme.colors.separator }]} />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </Card>
            {/* Weeks 16а–16б: the stickers' two modes — only while «Доска» is on (Ф-38). */}
            {boardOn && page.templateKey === 'notes' && layout === 'builtin:notes_board' ? (
              <SegmentedControl<'rows' | 'board'>
                segments={[
                  { key: 'rows', label: t('notes.mode_rows'), testID: 'settings-notes-rows' },
                  { key: 'board', label: t('notes.mode_board'), testID: 'settings-notes-board' },
                ]}
                value={page.view?.mode === 'board' ? 'board' : 'rows'}
                onChange={(k) => {
                  const board = page.view?.mode === 'board';
                  if ((k === 'board') !== board) void changeView(page, { kind: 'board', on: k === 'board' });
                }}
              />
            ) : null}
          </Section>

          {full ? (
            <Section title={t('view.fields')}>
              <Card padded={false} style={styles.clip}>
                {listed.map((f, i) => {
                  const label = fname(f);
                  const a11y = f.required
                    ? t('view.field_required_a11y', { field: label })
                    : t(f.visible ? 'view.field_on_a11y' : 'view.field_off_a11y', { field: label });
                  return (
                    <View
                      key={f.id}
                      testID={`settings-field-${f.id}`}
                      style={[
                        styles.row,
                        { minHeight: theme.size.rowHeight, paddingLeft: theme.space[3], gap: theme.space[2], flexWrap: theme.largeFont ? 'wrap' : 'nowrap' },
                      ]}
                    >
                      {f.required ? (
                        <View accessible accessibilityLabel={a11y} style={[styles.row, styles.flex, { gap: theme.space[3], minHeight: theme.size.minTouch }]}>
                          <Icon icon={Lock} size="sm" color="iconSecondary" />
                          <View style={styles.flex}>
                            <AppText>{label}</AppText>
                            <AppText testID={`settings-field-lock-${f.id}`} variant="footnote">
                              {t('view.required')}
                            </AppText>
                          </View>
                        </View>
                      ) : (
                        <Pressable
                          testID={`settings-field-toggle-${f.id}`}
                          accessibilityRole="switch"
                          accessibilityLabel={a11y}
                          accessibilityState={{ checked: f.visible }}
                          onPress={() => void changeView(page, { kind: 'field_visible', fieldId: f.id, visible: !f.visible })}
                          style={[styles.row, styles.flex, { gap: theme.space[3], minHeight: theme.size.minTouch }]}
                        >
                          <CheckMark checked={f.visible} />
                          <View style={styles.flex}>
                            <AppText color={f.visible ? 'ink' : 'ink2'}>{label}</AppText>
                            {f.custom ? <AppText variant="footnote">{typeName(f)}</AppText> : null}
                          </View>
                        </Pressable>
                      )}
                      <View style={styles.row}>
                        <Pressable
                          testID={`settings-field-up-${f.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={t('move.up_a11y', { what: label })}
                          accessibilityState={{ disabled: i === 0 }}
                          disabled={i === 0}
                          onPress={() => void changeView(page, { kind: 'field_move', fieldId: f.id, step: -1 })}
                          style={[square, { opacity: i === 0 ? 0.35 : 1 }]}
                        >
                          <Icon icon={ArrowUp} size="sm" color="brand" />
                        </Pressable>
                        <Pressable
                          testID={`settings-field-down-${f.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={t('move.down_a11y', { what: label })}
                          accessibilityState={{ disabled: i === listed.length - 1 }}
                          disabled={i === listed.length - 1}
                          onPress={() => void changeView(page, { kind: 'field_move', fieldId: f.id, step: 1 })}
                          style={[square, { opacity: i === listed.length - 1 ? 0.35 : 1 }]}
                        >
                          <Icon icon={ArrowDown} size="sm" color="brand" />
                        </Pressable>
                        {f.custom ? (
                          <Button
                            testID={`settings-field-remove-${f.id}`}
                            label={t('view.remove_field')}
                            accessibilityLabel={t('view.remove_field_a11y', { field: label })}
                            variant="text"
                            labelColor="danger"
                            onPress={() => void changeView(page, { kind: 'custom_remove', fieldId: f.id })}
                          />
                        ) : null}
                      </View>
                      {i < listed.length - 1 ? (
                        <View style={[styles.divider, { left: theme.space[3], backgroundColor: theme.colors.separator }]} />
                      ) : null}
                    </View>
                  );
                })}
              </Card>
              <View style={[styles.row, { gap: theme.space[3], flexWrap: 'wrap' }]}>
                <Button
                  testID="settings-add-field"
                  label={t('view.add_field')}
                  variant="secondary"
                  size="small"
                  disabled={ownCount >= MAX_CUSTOM_FIELDS}
                  onPress={() => setAdding(true)}
                />
                <AppText testID="settings-own-count" variant="footnote">
                  {ownCount >= MAX_CUSTOM_FIELDS ? t('view.err_custom_limit') : t('view.own_count', { count: ownCount, max: MAX_CUSTOM_FIELDS })}
                </AppText>
              </View>
            </Section>
          ) : null}

          {full ? (
            <ListGroup title={t('view.order_section')}>
              <ListRow
                testID="settings-sort"
                title={t('view.sort')}
                accessibilityLabel={`${t('view.sort')}: ${t(`view.sort_${page.view?.sort ?? 'position'}`)}`}
                right={<AppText color="ink2">{t(`view.sort_${page.view?.sort ?? 'position'}`)}</AppText>}
                chevron
                onPress={() => setSheet('sort')}
              />
              <ListRow
                testID="settings-group"
                title={t('view.group')}
                right={
                  <AppText color="ink2">{groupOptions.find((o) => o.key === (page.view?.groupBy ?? ''))?.label ?? t('view.group_none')}</AppText>
                }
                chevron
                onPress={() => setSheet('group')}
              />
            </ListGroup>
          ) : null}

          {full ? (
            <Button testID="settings-reset" label={t('view.reset')} variant="text" style={styles.start} onPress={() => setSheet('reset')} />
          ) : null}
        </View>
      </ScrollView>
      <StandaloneUndoStrip />

      {adding ? (
        <AddFieldSheet
          onClose={() => setAdding(false)}
          onAdd={(fieldName, type) => {
            setAdding(false);
            void changeView(page, { kind: 'custom_add', field: { id: newFieldId(newId()), title: fieldName, type } });
          }}
        />
      ) : null}
      {sheet === 'sort' ? (
        <ChoiceSheet
          testID="settings-sort-sheet"
          title={t('view.sort')}
          value={page.view?.sort ?? 'position'}
          options={SORTS.filter((k) => k !== 'title' || fields.some((f) => f.id === 'title')).map((k) => ({ key: k, label: t(`view.sort_${k}`) }))}
          onClose={() => setSheet(null)}
          onPick={(k) => {
            setSheet(null);
            void changeView(page, { kind: 'sort', sort: k === 'position' ? null : k });
          }}
        />
      ) : null}
      {sheet === 'group' ? (
        <ChoiceSheet
          testID="settings-group-sheet"
          title={t('view.group')}
          value={page.view?.groupBy ?? ''}
          options={groupOptions}
          onClose={() => setSheet(null)}
          onPick={(k) => {
            setSheet(null);
            void changeView(page, { kind: 'group', groupBy: k || null });
          }}
        />
      ) : null}
      {sheet === 'reset' ? (
        <ConfirmSheet
          title={t('view.reset_q')}
          body={t('view.reset_body')}
          yes={t('view.reset_yes')}
          onYes={() => {
            setSheet(null);
            void changeView(page, { kind: 'reset' });
          }}
          onNo={() => setSheet(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[2] }}>
      <AppText variant="sectionLabel" color="ink2" accessibilityRole="header" style={{ paddingHorizontal: theme.space[1] }}>
        {title}
      </AppText>
      {children}
    </View>
  );
}

/** S25: the question with the numbers; «Нет» first in focus, «Да» never in focus by default. */
function ConfirmSheet({ title, body, yes, onYes, onNo }: { title: string; body: string; yes: string; onYes: () => void; onNo: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet
      visible
      testID="confirm-sheet"
      title={title}
      closeButton={false}
      onClose={onNo}
      footer={
        <>
          <Button testID="confirm-no" label={t('view.no')} variant="secondary" onPress={onNo} />
          <Button testID="confirm-yes" label={yes} variant="text" labelColor="danger" onPress={onYes} />
        </>
      }
    >
      <AppText>{body}</AppText>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  start: { alignSelf: 'flex-start' },
  clip: { overflow: 'hidden' },
  divider: { position: 'absolute', right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
});
