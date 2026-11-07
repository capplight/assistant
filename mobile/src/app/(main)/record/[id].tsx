import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Check, ChevronLeft, TriangleAlert } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { isTrashed } from '@/db/records';
import { recordTitle, sourceLine, statusLine } from '@/records/format';
import { pluralForm, reviewRows, type ReviewRow } from '@/records/review';
import { useRecord } from '@/records/useRecords';
import { getRecordActions, refreshRecord } from '@/services';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

/** The server's limit for one «Исправить». */
const MAX_FIX = 500;
const NUMERIC_FIELDS = new Set(['phone', 'amount', 'iin_bin']);

const KNOWN_FIELDS = new Set(['phone', 'amount', 'iin_bin', 'iban', 'doc_number', 'transcript']);

/**
 * S09: the record card. What it is, where from, what was understood, and «Проверьте»: «Верно» or
 * «Исправить» (R-36: only the person removes the mark), «Удалить». All of them work offline through
 * the outbox. A whole recognized passage has no value of its own to correct: only «Верно» there.
 * Not here yet: «Ещё», «Показать ещё на…», stacks, originals (later weeks).
 */
export default function RecordScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  // `ret`: opened from a source chip of an answer → «‹ Назад к ответу» goes back there (2-design §4.4 п. 5).
  const { id, from, q, ret } = useLocalSearchParams<{ id: string; from?: string; q?: string; ret?: string }>();
  const record = useRecord(id);
  const showDeleted = useUndo((s) => s.showDeleted);
  const [asking, setAsking] = useState<ReviewRow | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const serverId = record?.serverId;

  useEffect(() => {
    if (serverId) void refreshRecord(serverId);
  }, [serverId]);

  // «Напомни про это», «удали это»: with the card open, «это» is this record (US-30).
  useFocusEffect(
    useCallback(() => {
      if (!serverId) return undefined;
      useView.getState().setSelected(serverId);
      return () => {
        if (useView.getState().selected === serverId) useView.getState().setSelected(null);
      };
    }, [serverId]),
  );

  const back = () => {
    if (ret) router.navigate(ret as never);
    else if (from) router.navigate({ pathname: '/page/[id]', params: { id: from } });
    else if (q) router.navigate({ pathname: '/search', params: { q } });
    else router.navigate('/records');
  };

  const backRow = (
    <Pressable
      testID="record-back"
      accessibilityRole="button"
      accessibilityLabel={ret ? t('record.back_answer') : t('common.back')}
      onPress={back}
      style={[styles.back, { minHeight: theme.size.minTouch }]}
    >
      <ChevronLeft size={24} color={theme.colors.accent} />
      <AppText color="accent">{ret ? t('record.back_answer') : t('common.back')}</AppText>
    </Pressable>
  );

  if (record === undefined) return <Screen testID="record-loading" edges={['top']}>{null}</Screen>;
  const closeSheet = () => {
    setAsking(null);
    setFixing(null);
  };

  if (record === null || isTrashed(record)) {
    return (
      <Screen testID="record-missing" edges={['top']}>
        {backRow}
        <AppText variant="title1">{t('record.not_found')}</AppText>
      </Screen>
    );
  }

  const rows = reviewRows(record);
  const toCheck = rows.filter((r) => !r.verified);
  const fieldLabel = (kind: string) => t(`check.field.${KNOWN_FIELDS.has(kind) ? kind : 'other'}`);
  const title = recordTitle(record, t);
  const status = statusLine(record, t);
  // The title may already be the text: do not print the same words twice.
  const body = record.text && record.text !== title ? record.text : null;

  return (
    <Screen testID="record-card" edges={['top']}>
      {backRow}
      <AppText variant="title2" accessibilityRole="header" style={{ marginBottom: theme.space[1] }}>
        {title}
      </AppText>
      <AppText variant="meta" style={{ marginBottom: theme.space[1] }}>
        {sourceLine(record, i18n.language, t)}
      </AppText>
      {status ? (
        <AppText testID="record-status" variant="meta" style={{ marginBottom: theme.space[1] }}>
          {status}
        </AppText>
      ) : null}
      {record.aiGenerated ? (
        <AppText testID="record-ai-label" variant="meta" style={{ marginBottom: theme.space[1] }}>
          {t('ai.label')}
        </AppText>
      ) : null}

      {toCheck.length > 0 ? (
        <View
          testID="check-banner"
          style={[
            styles.banner,
            {
              backgroundColor: theme.colors.markerSoft,
              borderRadius: theme.radius.card,
              padding: theme.space[3],
              marginTop: theme.space[3],
              gap: theme.space[2],
            },
          ]}
        >
          <TriangleAlert size={22} color={theme.colors.warnText} />
          <AppText color="warnText" style={styles.flex}>
            {t(`check.banner.${pluralForm(toCheck.length)}`, { n: toCheck.length })}
          </AppText>
          <Button
            testID="check-show"
            label={t('check.show')}
            variant="text"
            minHeight={theme.size.minTouch}
            onPress={() => setAsking(toCheck[0] ?? null)}
          />
        </View>
      ) : null}

      {rows.length > 0 ? (
        <View style={{ marginTop: theme.space[6], gap: theme.space[2] }}>
          <AppText variant="section" accessibilityRole="header">
            {t('record.understood')}
          </AppText>
          {rows.map((row) => (
            <Pressable
              key={row.key}
              testID={`check-field-${row.key}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: row.verified }}
              accessibilityLabel={
                row.verified
                  ? `${fieldLabel(row.kind)}: ${row.value ?? ''}. ${t('check.verified')}`
                  : t('check.a11y', { label: fieldLabel(row.kind), value: row.value ?? '' })
              }
              disabled={row.verified}
              onPress={() => setAsking(row)}
              style={{
                minHeight: theme.size.minTouch,
                padding: theme.space[3],
                borderRadius: theme.radius.input,
                backgroundColor: row.verified ? theme.colors.surface : theme.colors.markerSoft,
                gap: theme.space[1],
              }}
            >
              <AppText variant="meta">{fieldLabel(row.kind)}</AppText>
              <AppText variant="number">{row.value ?? ''}</AppText>
              <View style={[styles.mark, { gap: theme.space[1] }]}>
                {row.verified ? <Check size={18} color={theme.colors.done} /> : null}
                <AppText variant="meta" color={row.verified ? 'done' : 'warnText'}>
                  {row.verified ? t('check.verified') : t('check.badge')}
                </AppText>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}

      {record.summary && record.summary !== title ? (
        <AppText style={{ marginTop: theme.space[6] }}>{record.summary}</AppText>
      ) : null}
      {body ? (
        <View style={{ marginTop: theme.space[6], gap: theme.space[2] }}>
          <AppText variant="section" accessibilityRole="header">
            {t('record.text')}
          </AppText>
          <AppText selectable testID="record-text">
            {body}
          </AppText>
        </View>
      ) : null}

      <Button
        testID="record-delete"
        label={t('record.delete')}
        variant="text"
        labelColor="alarm"
        style={{ marginTop: theme.space[8] }}
        onPress={() => {
          const recordId = record.id;
          void getRecordActions().then((a) => a.remove(recordId));
          showDeleted(recordId);
          back();
        }}
      />

      {asking ? (
        <Modal visible transparent animationType="slide" onRequestClose={closeSheet}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}
          >
            <SafeAreaView
              edges={['bottom']}
              testID="check-sheet"
              style={[
                {
                  backgroundColor: theme.colors.surface,
                  borderTopLeftRadius: theme.radius.sheet,
                  borderTopRightRadius: theme.radius.sheet,
                  padding: theme.space[5],
                  gap: theme.space[3],
                },
                theme.elevation?.sheet,
              ]}
            >
              <AppText variant="meta">{fieldLabel(asking.kind)}</AppText>
              {fixing === null ? (
                <>
                  <AppText variant="title2" accessibilityRole="header">
                    {t('check.confirm', { value: asking.value ?? '' })}
                  </AppText>
                  <Button
                    testID="check-ok"
                    label={t('check.ok')}
                    onPress={() => {
                      const key = asking.key;
                      closeSheet();
                      void getRecordActions().then((a) => a.verify(record.id, key));
                    }}
                  />
                  {asking.value !== null && asking.kind !== 'transcript' ? (
                    <Button
                      testID="check-fix"
                      label={t('check.fix')}
                      variant="outline"
                      onPress={() => setFixing(asking.value ?? '')}
                    />
                  ) : null}
                  <Button testID="check-close" label={t('common.close')} variant="text" onPress={closeSheet} />
                </>
              ) : (
                <>
                  <AppText variant="title2" accessibilityRole="header">
                    {t('check.fix_title')}
                  </AppText>
                  <TextInput
                    testID="check-fix-input"
                    accessibilityLabel={fieldLabel(asking.kind)}
                    autoFocus
                    value={fixing}
                    onChangeText={setFixing}
                    maxLength={MAX_FIX}
                    keyboardType={NUMERIC_FIELDS.has(asking.kind) ? 'phone-pad' : 'default'}
                    maxFontSizeMultiplier={MAX_FONT_SCALE}
                    style={[
                      theme.type.body,
                      {
                        minHeight: theme.size.primaryTouch,
                        borderWidth: 1,
                        borderColor: theme.colors.lineStrong,
                        borderRadius: theme.radius.input,
                        paddingHorizontal: theme.space[3],
                        color: theme.colors.ink,
                        backgroundColor: theme.colors.bg,
                      },
                    ]}
                  />
                  <Button
                    testID="check-fix-save"
                    label={t('check.save')}
                    disabled={!fixing.trim()}
                    onPress={() => {
                      const { key } = asking;
                      const value = fixing;
                      closeSheet();
                      void getRecordActions().then((a) => a.correct(record.id, key, value));
                    }}
                  />
                  <Button testID="check-fix-cancel" label={t('check.cancel')} variant="text" onPress={closeSheet} />
                </>
              )}
            </SafeAreaView>
          </KeyboardAvoidingView>
        </Modal>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  banner: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  mark: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1, minWidth: 160 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
