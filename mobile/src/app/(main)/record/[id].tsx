import { router, useLocalSearchParams } from 'expo-router';
import { Check, ChevronLeft, TriangleAlert } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { recordTitle, sourceLine, statusLine } from '@/records/format';
import { pluralForm, reviewRows, type ReviewRow } from '@/records/review';
import { useRecord } from '@/records/useRecords';
import { getRecordActions, refreshRecord } from '@/services';
import { useTheme } from '@/theme';

const KNOWN_FIELDS = new Set(['phone', 'amount', 'iin_bin', 'iban', 'doc_number', 'transcript']);

/**
 * S09: the record card. What it is, where from, what was understood, and «Проверьте» / «Верно»
 * (R-36: only «Верно» removes the mark; it works offline through the outbox).
 * Not here yet: «Ещё», «Показать ещё на…», stacks, originals (later weeks).
 */
export default function RecordScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>();
  const record = useRecord(id);
  const [asking, setAsking] = useState<ReviewRow | null>(null);
  const serverId = record?.serverId;

  useEffect(() => {
    if (serverId) void refreshRecord(serverId);
  }, [serverId]);

  const back = () => {
    if (from) router.navigate({ pathname: '/page/[id]', params: { id: from } });
    else router.navigate('/records');
  };

  const backRow = (
    <Pressable
      testID="record-back"
      accessibilityRole="button"
      accessibilityLabel={t('common.back')}
      onPress={back}
      style={[styles.back, { minHeight: theme.size.minTouch }]}
    >
      <ChevronLeft size={24} color={theme.colors.accent} />
      <AppText color="accent">{t('common.back')}</AppText>
    </Pressable>
  );

  if (record === undefined) return <Screen testID="record-loading" edges={['top']}>{null}</Screen>;
  if (record === null) {
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

      {asking ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setAsking(null)}>
          <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
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
              <AppText variant="title2" accessibilityRole="header">
                {t('check.confirm', { value: asking.value ?? '' })}
              </AppText>
              <Button
                testID="check-ok"
                label={t('check.ok')}
                onPress={() => {
                  const key = asking.key;
                  setAsking(null);
                  void getRecordActions().then((a) => a.verify(record.id, key));
                }}
              />
              <Button
                testID="check-close"
                label={t('common.close')}
                variant="outline"
                onPress={() => setAsking(null)}
              />
            </SafeAreaView>
          </View>
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
