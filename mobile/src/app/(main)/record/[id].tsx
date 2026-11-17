import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { AiLabel } from '@/components/AiLabel';
import { Check } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button, Header, Sheet } from '@/components/ui';
import { Screen } from '@/components/Screen';
import { isTrashed } from '@/db/records';
import { recordTitle, sourceLine, statusLine } from '@/records/format';
import { pluralForm, reviewRows, type ReviewRow } from '@/records/review';
import { useRecord } from '@/records/useRecords';
import { getRecordActions, refreshRecord } from '@/services';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import { SimilarNote } from '@/components/SimilarNote';
import { ChangedPlate } from '@/components/ChangedMark';
import { MAX_FONT_SCALE, placeOfTemplate, useTheme } from '@/theme';
import { usePageLabels } from '@/pages/usePageLabels';
import { usePages } from '@/store/pages';

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
  const pages = usePages((s) => s.pages);
  const { title: pageLabel } = usePageLabels();
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

  // v5: the record opens with the sheet of its place already collapsed: «‹ Заметки» on the strip.
  const fromPage = pages.find((p) => p.id === (from ?? record?.pageId));
  const place = fromPage ? placeOfTemplate(fromPage.templateKey) : 'stone';
  const backLabel = ret ? t('record.back_answer') : fromPage ? pageLabel(fromPage) : t('common.back');
  const sheet = <Header title="" back={{ onPress: back, label: backLabel, testID: 'record-back' }} />;

  if (record === undefined) return <Screen testID="record-loading" edges={['top']}>{null}</Screen>;
  const closeSheet = () => {
    setAsking(null);
    setFixing(null);
  };

  if (record === null || isTrashed(record)) {
    return (
      <Screen testID="record-missing" mode="strip" place={place}>
        {sheet}
        <AppText variant="largeTitle">{t('record.not_found')}</AppText>
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
    <Screen testID="record-card" mode="strip" place={place} askRoom>
      {sheet}
      <ChangedPlate at={record.assistantChangedAt} actionId={record.assistantActionId} />
      <AppText variant="title1" accessibilityRole="header" style={{ marginBottom: 4, fontSize: 26, lineHeight: 31 }}>
        {title}
      </AppText>
      <AppText variant="footnote" style={{ marginBottom: theme.space[1] }}>
        {sourceLine(record, i18n.language, t)}
      </AppText>
      {status ? (
        <AppText testID="record-status" variant="callout" style={{ marginBottom: theme.space[1] }}>
          {status}
        </AppText>
      ) : null}
      <SimilarNote serverId={record.serverId} />
      {record.aiGenerated ? (
        <AiLabel testID="record-ai-label" variant="callout" style={{ marginBottom: theme.space[1] }} />
      ) : null}

      {toCheck.length > 0 ? (
        <View
          testID="check-banner"
          style={[
            styles.banner,
            {
              backgroundColor: theme.colors.paper2,
              borderRadius: 16,
              paddingVertical: 12,
              paddingHorizontal: 14,
              marginTop: theme.space[3],
              gap: theme.space[2],
            },
          ]}
        >
          <AppText style={[styles.flex, { fontSize: 15.5, lineHeight: 22 }]}>
            {t(`check.banner.${pluralForm(toCheck.length)}`, { n: toCheck.length })}
          </AppText>
          <Button
            testID="check-show"
            label={t('check.show')}
            variant="link"
            size="small"
            minHeight={theme.size.minTouch}
            onPress={() => setAsking(toCheck[0] ?? null)}
          />
        </View>
      ) : null}

      {rows.length > 0 ? (
        <View style={{ marginTop: theme.space[5] }}>
          <AppText variant="section" accessibilityRole="header" style={{ marginBottom: 6 }}>
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
              // screens-v5-extra «Запись · голосовая»: «Что я понял» as rows; a doubtful value is underlined with a dashed
              // line and «проверьте» — a request, not an error (no red, no terracotta).
              style={{ minHeight: theme.m.row, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.colors.line, gap: 2 }}
            >
              <AppText variant="footnote">{fieldLabel(row.kind)}</AppText>
              <View style={[styles.mark, { gap: 8 }]}>
                <AppText
                  variant="number"
                  style={row.verified ? null : { textDecorationLine: 'underline', textDecorationStyle: 'dashed', textDecorationColor: theme.colors.ink3 }}
                >
                  {row.value ?? ''}
                </AppText>
                {row.verified ? <Check size={16} color={theme.colors.ink3} /> : null}
                <AppText variant="footnote">{row.verified ? t('check.verified') : t('check.badge')}</AppText>
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
          <AppText selectable testID="record-text" variant="noteBody">
            {body}
          </AppText>
        </View>
      ) : null}

      {/* Into the trash, reversible («Удалено · Восстановить»): an ordinary link, never red (§11.3). */}
      <Button
        testID="record-delete"
        label={t('record.delete')}
        variant="link"
        style={{ marginTop: theme.space[8] }}
        onPress={() => {
          const recordId = record.id;
          void getRecordActions().then((a) => a.remove(recordId));
          showDeleted(recordId, recordTitle(record, t));
          back();
        }}
      />

      {asking ? (
        <Sheet visible testID="check-sheet" closeButton={false} onClose={closeSheet}>
              <AppText variant="footnote">{fieldLabel(asking.kind)}</AppText>
              {fixing === null ? (
                <>
                  {/* screens-v5-extra «Проверьте значение»: the value itself, large, then the question. */}
                  {asking.value ? <AppText style={[theme.type.title, { fontVariant: ['tabular-nums'] }]}>{asking.value}</AppText> : null}
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
                      variant="text"
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
                        minHeight: theme.size.buttonHeight,
                        borderRadius: 16,
                        borderWidth: 1.5,
                        borderColor: theme.colors.ink,
                        paddingHorizontal: theme.space[4],
                        color: theme.colors.ink,
                        backgroundColor: theme.colors.paper,
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
        </Sheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  mark: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1, minWidth: 160 },
});
