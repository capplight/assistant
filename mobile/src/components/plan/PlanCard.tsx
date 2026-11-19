import { router } from 'expo-router';
import { ListChecks } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { PlaceTab } from '@/components/ui/Leaf';
import { StepList } from '@/components/ui/Steps';
import { makePlanTasks } from '@/plans/service';
import type { PlanCardOut, PlanCardRow } from '@/plans/types';
import { usePages } from '@/store/pages';
import { onPlace, placeOfTemplate, useTheme } from '@/theme';

const shortDay = (iso: string, lang: string, o: Intl.DateTimeFormatOptions) => {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(lang, o).replace(/\.$/u, '');
  } catch {
    return iso;
  }
};

/** «ср 10 · Султанахмет, Гранд-базар» / «День 1 · …». */
export function tripRowText(
  r: PlanCardRow,
  lang: string,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const day = r.date
    ? `${shortDay(r.date, lang, { weekday: 'short' })} ${Number(r.date.slice(8))}`
    : t('plan.day_n', { n: r.n });
  return `${day} · ${r.title}`;
}

/** «до ср, 18 нояб. · после шага 1 · номер в заметках». */
export function stepMeta(
  o: { due_date: string | null; after: number[]; note: string | null },
  lang: string,
  t: (k: string, x?: Record<string, unknown>) => string,
): string {
  return [
    o.due_date
      ? t('plan.due', { day: shortDay(o.due_date, lang, { weekday: 'short', day: 'numeric', month: 'short' }) })
      : null,
    ...o.after.map((n) => t('plan.after', { n })),
    o.note,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * screens-v5-extra «Помощник · карточка «План»» (plans.md): the lead above, the card in the colour of the place it lies
 * on — «План · в «Заметки»», «Стамбул · 5 дней · 23 совета», the first 3 days, «составил по вашим записям — проверьте»,
 * «Открыть» (and «Сделать делами» for an action plan). No «Сохранить»: the plan is saved; «Отменить» is the action's.
 */
export function PlanCard({ plan, testID }: { plan: PlanCardOut; testID?: string }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const pages = usePages((s) => s.pages);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(false);
  const page = plan.page ? pages.find((p) => p.serverId === plan.page!.page_id) : undefined;
  const open = () => router.navigate({ pathname: '/plan/[id]', params: { id: plan.item_id } });
  const toTasks = async () => {
    setBusy(true);
    const out = await makePlanTasks(plan.item_id);
    setBusy(false);
    if (out) setMade(!out.can_make_tasks);
  };
  const canTasks = plan.can_make_tasks && !made;
  const buttons = (
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      {canTasks ? (
        <View style={{ flexGrow: 1.6, minWidth: 140 }}>
          <Button
            testID={testID ? `${testID}-tasks` : undefined}
            label={t('plan.make_tasks')}
            size="small"
            minHeight={42}
            disabled={busy}
            icon={<ListChecks size={18} color={theme.colors.onBtn} strokeWidth={2.2} />}
            onPress={() => void toTasks()}
          />
        </View>
      ) : null}
      <View style={{ flexGrow: 1, minWidth: 110 }}>
        <Button
          testID={testID ? `${testID}-open` : undefined}
          label={t('plan.open')}
          size="small"
          minHeight={42}
          variant={canTasks ? 'secondary' : 'primary'}
          onPress={open}
        />
      </View>
    </View>
  );

  if (plan.kind === 'actions') {
    // An action plan: a paper2 plate «План · станет делами» with the first steps in circles.
    const shown = plan.rows.slice(0, 3);
    const more = plan.rows.length - shown.length;
    return (
      <View
        testID={testID}
        style={{ backgroundColor: theme.colors.paper2, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <PlaceTab place="tasks" style={{ width: 12, height: 16 }} />
          <AppText variant="caption" style={{ color: theme.colors.ink3 }}>
            {t('plan.becomes_tasks')}
          </AppText>
        </View>
        <AppText
          accessibilityRole="header"
          style={{ marginTop: 6, fontFamily: theme.type.headline.fontFamily, fontSize: 18, lineHeight: 23 }}
        >
          {[plan.title, plan.subtitle].filter(Boolean).join(' · ')}
        </AppText>
        <StepList
          steps={[
            ...shown.map((r) => ({
              text: r.title,
              hint: stepMeta({ due_date: r.due_date, after: r.after_n, note: r.note }, i18n.language, t) || undefined,
            })),
            ...(more > 0 ? [{ text: t('plan.more_steps', { count: more }) }] : []),
          ]}
        />
        {plan.check_note ? (
          <AppText variant="footnote" style={{ color: theme.colors.ink3 }}>
            {plan.check_note}
          </AppText>
        ) : null}
        {buttons}
      </View>
    );
  }

  const place = page ? placeOfTemplate(page.templateKey) : 'notes';
  const c = onPlace(theme.colors, place);
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: theme.colors.place[place],
        borderRadius: 18,
        paddingVertical: 14,
        paddingHorizontal: 16,
      }}
    >
      <AppText style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 13, lineHeight: 16, color: c.ink2 }}>
        {t('plan.lies_in', { page: plan.page?.title ?? t('tpl.notes') })}
      </AppText>
      <AppText
        accessibilityRole="header"
        style={{ marginTop: 2, fontFamily: theme.type.headline.fontFamily, fontSize: 18, lineHeight: 23, color: c.ink }}
      >
        {[plan.title, plan.subtitle].filter(Boolean).join(' · ')}
      </AppText>
      <View style={{ marginTop: 6 }}>
        {plan.rows.slice(0, 3).map((r) => (
          <AppText
            key={r.n}
            numberOfLines={1}
            style={{
              fontFamily: theme.type.bodyStrong.fontFamily,
              fontSize: 15,
              lineHeight: 22,
              color: c.ink,
              fontVariant: ['tabular-nums'],
            }}
          >
            {tripRowText(r, i18n.language, t)}
          </AppText>
        ))}
      </View>
      {plan.check_note ? (
        <AppText
          style={{
            marginTop: 6,
            fontFamily: theme.type.sheetMeta.fontFamily,
            fontSize: 13.5,
            lineHeight: 18,
            color: c.ink2,
          }}
        >
          {plan.check_note}
        </AppText>
      ) : null}
      {buttons}
    </View>
  );
}
