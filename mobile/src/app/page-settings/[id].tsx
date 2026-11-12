import { router, useLocalSearchParams } from 'expo-router';
import { ArrowDown, ArrowUp, Check, Lock } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { PageIcon } from '@/components/Icon';
import { AddFieldSheet, ChoiceSheet } from '@/components/page/FieldSheets';
import { effectiveLayout, hasTool } from '@/components/page/registry';
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
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { MAX_FONT_SCALE, useTheme } from '@/theme';
import { newId } from '@/utils/id';

const ICONS: IconKey[] = ['home', 'money', 'documents', 'shopping', 'health', 'people', 'work', 'other'];
const SORTS = ['position', 'newest', 'oldest', 'title'] as const;

/**
 * S38 «Настроить страницу» (2-design 4.6, S38; R-51 widened by Ф-31, template-screens 2.8): the
 * live example «Так выглядит запись» on top; name; 8 icons; fields — ★ with a lock («Нужно для
 * работы — скрыть нельзя»), the others with a 48 pt switch and ↑ ↓; «+ Своё поле» (≤5, 5 types);
 * «Вид» from what the template allows, «Простой список» always (Ф-30); sort and grouping;
 * «Вернуть как было» through S25 with «Нет» in focus. Every change applies at once, offline too,
 * with «Отменить» in the strip at the bottom; «Готово» only closes. What the person sets here is
 * theirs: the assistant changes it only after their «Да».
 */
export default function PageSettingsScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const page = usePages((s) => s.pages.find((p) => p.id === id));
  const server = useCatalog((s) => s.server);
  const values = useFacets((s) => s.values);
  const entries = usePageEntries(page);
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

  if (!page) {
    return (
      <SafeAreaView testID="page-settings-missing" style={[styles.root, { backgroundColor: theme.colors.bg, padding: theme.screenPadding }]}>
        <Button testID="settings-back" label={`‹ ${t('common.back')}`} variant="text" minHeight={theme.size.minTouch} onPress={close} style={styles.start} />
        <AppText>{t('page.not_found')}</AppText>
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

  const section = (key: string) => (
    <AppText variant="sectionLabel" accessibilityRole="header" style={{ marginTop: theme.space[5] }}>
      {t(key)}
    </AppText>
  );

  return (
    <SafeAreaView testID="page-settings" edges={['top']} style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      <View style={[styles.row, { paddingHorizontal: theme.screenPadding, gap: theme.space[2], borderBottomWidth: 1, borderBottomColor: theme.colors.separator }]}>
        <Button testID="settings-back" label={`‹ ${t('common.back')}`} variant="text" minHeight={theme.size.minTouch} onPress={close} />
        <AppText variant="title2" accessibilityRole="header" style={[styles.flex, { textAlign: 'center' }]}>
          {t('view.settings')}
        </AppText>
        <Button testID="settings-done" label={t('page.order_done')} variant="text" minHeight={theme.size.minTouch} onPress={close} />
      </View>
      <ScrollView contentContainerStyle={{ padding: theme.screenPadding, gap: theme.space[2] }} keyboardShouldPersistTaps="handled">
        {section('view.example')}
        <View
          testID="settings-example"
          accessibilityLabel={listed
            .filter((f) => f.visible)
            .map((f) => `${fname(f)}: ${exampleValue(f)}`)
            .join('. ')}
          style={[styles.card, { borderColor: theme.colors.separator, backgroundColor: theme.colors.surface, borderRadius: theme.radius.lg, padding: theme.space[4], gap: theme.space[1] }]}
        >
          {listed
            .filter((f) => f.visible)
            .map((f, i) => (
              <AppText key={f.id} testID={`settings-example-${f.id}`} variant={i === 0 ? 'bodyStrong' : 'callout'} color="ink">
                {i === 0 ? exampleValue(f) : `${fname(f)}: ${exampleValue(f)}`}
              </AppText>
            ))}
        </View>

        {section('view.name')}
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
              borderWidth: 1,
              borderColor: theme.colors.iconSecondary,
              borderRadius: theme.radius.sm,
              paddingHorizontal: theme.space[3],
              color: theme.colors.ink,
              backgroundColor: theme.colors.surface,
            },
          ]}
        />

        {section('view.icon')}
        <View accessibilityRole="radiogroup" style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
          {ICONS.map((k) => (
            <Pressable
              key={k}
              testID={`settings-icon-${k}`}
              accessibilityRole="radio"
              accessibilityLabel={t(`view.icons.${k}`)}
              accessibilityState={{ checked: page.icon === k }}
              onPress={() => void changeView(page, { kind: 'icon', icon: k })}
              style={{
                width: theme.size.buttonHeight,
                height: theme.size.buttonHeight,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: theme.radius.md,
                borderWidth: page.icon === k ? 2 : 1,
                borderColor: page.icon === k ? theme.colors.brand : theme.colors.separator,
              }}
            >
              <PageIcon name={k} size={26} color={page.icon === k ? theme.colors.brand : theme.colors.ink} />
            </Pressable>
          ))}
        </View>

        {section('view.fields')}
        {listed.map((f, i) => {
          const label = fname(f);
          const a11y = f.required
            ? t('view.field_required_a11y', { field: label })
            : t(f.visible ? 'view.field_on_a11y' : 'view.field_off_a11y', { field: label });
          return (
            <View
              key={f.id}
              testID={`settings-field-${f.id}`}
              style={[styles.row, { minHeight: theme.size.buttonHeight, gap: theme.space[2], borderBottomWidth: 1, borderBottomColor: theme.colors.separator, flexWrap: theme.largeFont ? 'wrap' : 'nowrap' }]}
            >
              {f.required ? (
                <View accessible accessibilityLabel={a11y} style={[styles.row, styles.flex, { gap: theme.space[2], minHeight: theme.size.minTouch }]}>
                  <Lock size={22} color={theme.colors.ink2} />
                  <View style={styles.flex}>
                    <AppText>{label}</AppText>
                    <AppText testID={`settings-field-lock-${f.id}`} variant="callout">
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
                  style={[styles.row, styles.flex, { gap: theme.space[2], minHeight: theme.size.minTouch }]}
                >
                  <View
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 6,
                      borderWidth: 2,
                      borderColor: theme.colors.brand,
                      backgroundColor: f.visible ? theme.colors.brand : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {f.visible ? <Check size={22} color={theme.colors.onBrand} /> : null}
                  </View>
                  <View style={styles.flex}>
                    <AppText color={f.visible ? 'ink' : 'ink2'}>{label}</AppText>
                    {f.custom ? <AppText variant="callout">{typeName(f)}</AppText> : null}
                  </View>
                </Pressable>
              )}
              <View style={[styles.row, { gap: theme.space[1] }]}>
                <Pressable
                  testID={`settings-field-up-${f.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={t('move.up_a11y', { what: label })}
                  accessibilityState={{ disabled: i === 0 }}
                  disabled={i === 0}
                  onPress={() => void changeView(page, { kind: 'field_move', fieldId: f.id, step: -1 })}
                  style={[styles.square, { width: theme.size.minTouch, height: theme.size.minTouch, opacity: i === 0 ? 0.35 : 1 }]}
                >
                  <ArrowUp size={24} color={theme.colors.brand} />
                </Pressable>
                <Pressable
                  testID={`settings-field-down-${f.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={t('move.down_a11y', { what: label })}
                  accessibilityState={{ disabled: i === listed.length - 1 }}
                  disabled={i === listed.length - 1}
                  onPress={() => void changeView(page, { kind: 'field_move', fieldId: f.id, step: 1 })}
                  style={[styles.square, { width: theme.size.minTouch, height: theme.size.minTouch, opacity: i === listed.length - 1 ? 0.35 : 1 }]}
                >
                  <ArrowDown size={24} color={theme.colors.brand} />
                </Pressable>
                {f.custom ? (
                  <Button
                    testID={`settings-field-remove-${f.id}`}
                    label={t('view.remove_field')}
                    accessibilityLabel={t('view.remove_field_a11y', { field: label })}
                    variant="text"
                    minHeight={theme.size.minTouch}
                    onPress={() => void changeView(page, { kind: 'custom_remove', fieldId: f.id })}
                  />
                ) : null}
              </View>
            </View>
          );
        })}
        <View style={[styles.row, { gap: theme.space[3], flexWrap: 'wrap', marginTop: theme.space[2] }]}>
          <Button
            testID="settings-add-field"
            label={t('view.add_field')}
            variant="secondary"
            minHeight={theme.size.buttonHeight}
            disabled={ownCount >= MAX_CUSTOM_FIELDS}
            onPress={() => setAdding(true)}
          />
          <AppText testID="settings-own-count" variant="callout">
            {ownCount >= MAX_CUSTOM_FIELDS ? t('view.err_custom_limit') : t('view.own_count', { count: ownCount, max: MAX_CUSTOM_FIELDS })}
          </AppText>
        </View>

        {section('view.view')}
        <View accessibilityRole="radiogroup" style={{ gap: theme.space[2] }}>
          {tpl.layouts.filter((l) => l === layout || hasTool(page.templateKey, l, tpl.defaultLayout)).map((l: Layout) => (
            <Pressable
              key={l}
              testID={`settings-layout-${l}`}
              accessibilityRole="radio"
              accessibilityState={{ checked: layout === l }}
              onPress={() => void changeView(page, { kind: 'layout', layout: l })}
              style={{
                minHeight: theme.size.buttonHeight,
                borderRadius: theme.radius.md,
                borderWidth: layout === l ? 2 : 1,
                borderColor: layout === l ? theme.colors.brand : theme.colors.separator,
                paddingHorizontal: theme.space[3],
                justifyContent: 'center',
              }}
            >
              <AppText color={layout === l ? 'brand' : 'ink'}>{`${layout === l ? '● ' : '○ '}${t(`view.layout.${layoutLabel(page.templateKey, l)}`)}`}</AppText>
              {l === 'list' && page.templateKey !== 'custom' ? <AppText variant="callout">{t('view.simple_hint')}</AppText> : null}
            </Pressable>
          ))}
        </View>
        {/* Weeks 16а–16б: the stickers' two modes, the same switch as on the page (Ф-28). */}
        {page.templateKey === 'notes' && layout === 'builtin:notes_board' ? (
          <View accessibilityRole="tablist" style={[styles.row, { gap: theme.space[2] }]}>
            {([false, true] as const).map((on) => {
              const board = page.view?.mode === 'board';
              return (
                <Button
                  key={String(on)}
                  testID={`settings-notes-${on ? 'board' : 'rows'}`}
                  label={t(on ? 'notes.mode_board' : 'notes.mode_rows')}
                  variant={on === board ? 'primary' : 'secondary'}
                  minHeight={theme.size.minTouch}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on === board }}
                  style={styles.flex}
                  onPress={() => {
                    if (on !== board) void changeView(page, { kind: 'board', on });
                  }}
                />
              );
            })}
          </View>
        ) : null}

        {section('view.order_section')}
        <SettingRow testID="settings-sort" label={t('view.sort')} value={t(`view.sort_${page.view?.sort ?? 'position'}`)} onPress={() => setSheet('sort')} />
        <SettingRow
          testID="settings-group"
          label={t('view.group')}
          value={groupOptions.find((o) => o.key === (page.view?.groupBy ?? ''))?.label ?? t('view.group_none')}
          onPress={() => setSheet('group')}
        />

        <Button
          testID="settings-reset"
          label={t('view.reset')}
          variant="text"
          style={{ marginTop: theme.space[6], alignSelf: 'flex-start' }}
          onPress={() => setSheet('reset')}
        />
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

function SettingRow({ testID, label, value, onPress }: { testID: string; label: string; value: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      onPress={onPress}
      style={[styles.row, { minHeight: theme.size.buttonHeight, gap: theme.space[2], borderBottomWidth: 1, borderBottomColor: theme.colors.separator, flexWrap: 'wrap' }]}
    >
      <AppText style={styles.flex}>{label}</AppText>
      <AppText color="brand">{`${value} ›`}</AppText>
    </Pressable>
  );
}

/** S25: the question with the numbers; «Нет» first in focus, «Да» never in focus by default. */
function ConfirmSheet({ title, body, yes, onYes, onNo }: { title: string; body: string; yes: string; onYes: () => void; onNo: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onNo}>
      <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID="confirm-sheet"
          style={{ backgroundColor: theme.colors.surface, borderTopLeftRadius: theme.radius.sheet, borderTopRightRadius: theme.radius.sheet, padding: theme.space[5], gap: theme.space[3] }}
        >
          <AppText variant="title2" accessibilityRole="header">
            {title}
          </AppText>
          <AppText>{body}</AppText>
          <Button testID="confirm-no" label={t('view.no')} variant="secondary" onPress={onNo} />
          <Button testID="confirm-yes" label={yes} onPress={onYes} />
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  start: { alignSelf: 'flex-start' },
  card: { borderWidth: 1 },
  square: { alignItems: 'center', justifyContent: 'center' },
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
