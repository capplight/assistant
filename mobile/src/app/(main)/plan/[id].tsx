import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Check, ListChecks } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Pressable, View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Screen } from '@/components/Screen';
import { stepMeta } from '@/components/plan/PlanCard';
import { Button } from '@/components/ui/Button';
import { Header } from '@/components/ui/Header';
import { SectionHead } from '@/components/ui/Leaf';
import { getRecords } from '@/db';
import { makePlanTasks, usePlan } from '@/plans/service';
import type { PlanOut, PlanPoint, PlanSource, PlanStep } from '@/plans/types';
import { kickSync } from '@/services';
import { useChrome } from '@/store/chrome';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useView } from '@/store/view';
import { useTheme } from '@/theme';

const fmt = (iso: string, lang: string, o: Intl.DateTimeFormatOptions, keepDot = false) => {
  try {
    const out = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(lang, o);
    return keepDot ? out : out.replace(/\.$/u, '');
  } catch {
    return iso;
  }
};

/** «10–14 декабря» / «28 ноября – 2 декабря». */
function datesLine(p: PlanOut, lang: string): string | null {
  if (!p.start_date) return null;
  const a = new Date(`${p.start_date}T00:00:00`);
  if (!p.end_date || p.end_date === p.start_date) return fmt(p.start_date, lang, { day: 'numeric', month: 'long' });
  const b = new Date(`${p.end_date}T00:00:00`);
  if (a.getMonth() === b.getMonth())
    return `${a.getDate()}–${fmt(p.end_date, lang, { day: 'numeric', month: 'long' })}`;
  return `${fmt(p.start_date, lang, { day: 'numeric', month: 'long' })} – ${fmt(p.end_date, lang, { day: 'numeric', month: 'long' })}`;
}

async function openSource(serverId: string, t: (k: string) => string) {
  const rec = await (await getRecords()).findByServerId(serverId);
  if (rec) router.navigate({ pathname: '/record/[id]', params: { id: rec.id } });
  else {
    kickSync();
    useToast.getState().show(t('save.replace_later'), 3000);
  }
}

/** A map search by the name (plans.md: no coordinates, by rule). */
const openMap = (place: string) =>
  void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`).catch(
    () => undefined,
  );

function Num({ n, done, ring }: { n: number; done?: boolean; ring?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          minWidth: 28,
          minHeight: 28,
          paddingHorizontal: 4,
          borderRadius: 14,
          alignItems: 'center',
          justifyContent: 'center',
        },
        done
          ? { backgroundColor: theme.colors.ink }
          : { borderWidth: 1.5, borderColor: ring ? theme.colors.ink3 : theme.colors.ink },
      ]}
    >
      {done ? (
        <Check size={16} color={theme.colors.paper} strokeWidth={3} />
      ) : (
        <AppText
          style={{
            fontFamily: theme.type.stripTitle.fontFamily,
            fontSize: 13,
            lineHeight: 16,
            fontVariant: ['tabular-nums'],
          }}
        >
          {String(n)}
        </AppText>
      )}
    </View>
  );
}

/** «мой совет, не из ваших записей» — the terracotta mark with its dot (`.chg`). */
function OwnMark({ label }: { label: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: theme.colors.place.assistant }} />
      <AppText
        style={{
          fontFamily: theme.type.stripTitle.fontFamily,
          fontSize: 13,
          lineHeight: 16,
          color: theme.colors.assistantText,
        }}
      >
        {label}
      </AppText>
    </View>
  );
}

function SmallLink({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, minHeight: 24, justifyContent: 'center' })}
    >
      <AppText variant="footnote" style={{ color: theme.colors.ink3 }}>
        {label}
      </AppText>
    </Pressable>
  );
}

function PointRow({
  p,
  n,
  first,
  source,
  lang,
}: {
  p: PlanPoint;
  n: number;
  first: boolean;
  source: PlanSource | undefined;
  lang: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const srcLabel = source
    ? [
        t(`plan.src_${source.kind ?? 'note'}`, { defaultValue: t('plan.src_note') }),
        source.occurred_at || source.created_at
          ? fmt((source.occurred_at || source.created_at)!, lang, { day: 'numeric', month: 'short' }, true)
          : null,
      ]
        .filter(Boolean)
        .join(' · ') + ' ›'
    : null;
  return (
    <View
      testID={`plan-point-${p.id}`}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 8,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <Num n={n} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText style={{ fontSize: 16, lineHeight: 22 }}>{p.note ? `${p.title} — ${p.note}` : p.title}</AppText>
        {p.own ? <OwnMark label={t('plan.own')} /> : null}
        {srcLabel || p.place ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 }}>
            {srcLabel && p.source_id && source?.available !== false ? (
              <SmallLink
                testID={`plan-src-${p.id}`}
                label={srcLabel}
                onPress={() => void openSource(p.source_id!, t)}
              />
            ) : null}
            {srcLabel && p.place ? (
              <AppText variant="footnote" style={{ color: theme.colors.ink3 }}>
                ·
              </AppText>
            ) : null}
            {p.place ? (
              <SmallLink testID={`plan-map-${p.id}`} label={t('plan.on_map')} onPress={() => openMap(p.place!)} />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function StepRow({ s, first, all, lang }: { s: PlanStep; first: boolean; all: PlanStep[]; lang: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const after = s.after.map((id) => all.find((x) => x.id === id)?.n).filter((x): x is number => typeof x === 'number');
  const meta = stepMeta({ due_date: s.task?.due_date ?? s.due_date, after, note: s.note }, lang, t);
  const state = s.task ? (s.task.done ? t('plan.task_done') : t('plan.task_open')) : null;
  return (
    <View
      testID={`plan-step-${s.id}`}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <Num n={s.n} done={!!s.task?.done} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText
          style={[
            { fontSize: 16, lineHeight: 22 },
            s.task?.done
              ? { color: theme.colors.ink3, textDecorationLine: 'line-through', textDecorationColor: theme.colors.ink3 }
              : null,
          ]}
        >
          {s.title}
        </AppText>
        {meta ? (
          <AppText variant="footnote" style={{ color: theme.colors.ink3 }}>
            {meta}
          </AppText>
        ) : null}
        {s.own ? <OwnMark label={t('plan.own')} /> : null}
      </View>
      {state ? (
        <AppText testID={`plan-step-state-${s.id}`} variant="footnote" style={{ color: theme.colors.ink3 }}>
          {state}
        </AppText>
      ) : null}
    </View>
  );
}

/**
 * The plan (plans.md, screens-v5-extra «План поездки» / «План действий»). A trip — days with dates, numbered points,
 * the source «видео · 3 окт. ›», «на карте», the assistant's own tips marked in terracotta. An action plan — steps
 * with the deadline and «после шага N», the live task state, «Сделать делами». The line changes the plan.
 */
export default function PlanScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { plan, error, reload, set } = usePlan(id);
  const pages = usePages((s) => s.pages);
  const [busy, setBusy] = useState(false);
  useFocusEffect(
    useCallback(() => {
      if (!id) return undefined;
      useView.getState().setSelected(id);
      useChrome.getState().setAskHint(null);
      return () => {
        if (useView.getState().selected === id) useView.getState().setSelected(null);
      };
    }, [id]),
  );
  const pageRow = plan?.pages[0];
  const page = pageRow ? pages.find((p) => p.serverId === pageRow.page_id) : undefined;
  const back = () =>
    router.canGoBack()
      ? router.back()
      : page
        ? router.replace({ pathname: '/page/[id]', params: { id: page.id } })
        : router.replace('/');
  const place = plan?.kind === 'actions' ? 'tasks' : 'notes';
  const toTasks = async () => {
    if (!plan) return;
    setBusy(true);
    const out = await makePlanTasks(plan.id);
    setBusy(false);
    if (out) set(out);
    else reload();
  };
  const header = (
    <Header
      title={plan ? t('plan.title', { title: plan.title }) : t('plan.loading')}
      back={{ onPress: back, label: pageRow?.title ?? t('tpl.notes'), testID: 'plan-back' }}
    />
  );

  if (!plan)
    return (
      <Screen testID="plan-screen" mode="strip" place={place} askRoom>
        {header}
        <AppText testID={error ? 'plan-error' : 'plan-loading'} variant="small">
          {error ? t('plan.error') : t('plan.loading')}
        </AppText>
        {error ? <Button testID="plan-retry" label={t('answer.retry_short')} variant="link" onPress={reload} /> : null}
      </Screen>
    );

  const dates = datesLine(plan, i18n.language);
  const top = [dates, plan.check_note].filter(Boolean).join(' · ');
  const sourceById = new Map(plan.sources.map((s) => [s.item_id, s] as const));
  let n = 0;
  return (
    <Screen testID="plan-screen" mode="strip" place={place} askRoom>
      {header}
      {top ? (
        <AppText testID="plan-top" variant="footnote" style={{ color: theme.colors.ink3 }}>
          {top}
        </AppText>
      ) : null}
      {plan.kind === 'trip' ? (
        plan.days.map((d, di) => {
          const day = d.date
            ? fmt(d.date, i18n.language, { weekday: 'short', day: 'numeric', month: 'long' })
            : t('plan.day_n', { n: d.n });
          return (
            <View key={d.n} testID={`plan-day-${d.n}`}>
              <SectionHead first={di === 0 && !top} title={d.title ? `${day} · ${d.title}` : day} />
              {d.points.map((p, i) => {
                n += 1;
                return (
                  <PointRow
                    key={p.id}
                    p={p}
                    n={n}
                    first={i === 0}
                    source={p.source_id ? sourceById.get(p.source_id) : undefined}
                    lang={i18n.language}
                  />
                );
              })}
            </View>
          );
        })
      ) : (
        <View testID="plan-steps">
          <SectionHead first={!top} title={t('plan.steps')} right={String(plan.steps.length)} />
          {plan.steps.map((s, i) => (
            <StepRow key={s.id} s={s} first={i === 0} all={plan.steps} lang={i18n.language} />
          ))}
          {plan.can_make_tasks ? (
            <View style={{ marginTop: 14 }}>
              <Button
                testID="plan-make-tasks"
                label={t('plan.make_tasks')}
                disabled={busy}
                icon={<ListChecks size={20} color={theme.colors.onBtn} strokeWidth={2.2} />}
                onPress={() => void toTasks()}
              />
            </View>
          ) : null}
        </View>
      )}
    </Screen>
  );
}
