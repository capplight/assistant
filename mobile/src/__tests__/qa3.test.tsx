import { render } from '@testing-library/react-native';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { StyleSheet, Text } from 'react-native';

import { clockOf } from '@/alarms/format';
import { expenseCategoryOut, expenseOut } from '@/api/endpoints';
import type { ExpenseCategoryOut, ExpenseOut, TaskOut } from '@/api/types';
import { chatRows } from '@/app/(main)/assistant';
import { keyboardLift, rideOffset } from '@/components/MainFooter';
import { weekStripHeight } from '@/components/today/EmptyToday';
import { BottomPaperFade, clearOf, expandedSheetHeight, phraseLines, PlaceScreen } from '@/components/ui/PlaceScreen';
import { applyServer } from '@/expenses/service';
import type { ChatMessage } from '@/store/assistant';
import { usePages } from '@/store/pages';
import { listRows, localDate } from '@/tasks/rows';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';
import { resetWindow, setWindow } from '@/testing/layoutAudit';
import { layoutMetricsFor, sheet } from '@/theme';

/** Device QA round 3 (docs/design/qa/v5-device-qa-3.md): jumps and stalls — what Jest can pin down. */

afterEach(() => resetWindow());

describe('J1 / §4.1: the sheet height comes from the tokens, not from the first frame', () => {
  const m = layoutMetricsFor({ width: 384, height: 860 });

  it('«Сегодня»: meta · a two-line phrase · the week = 10 + 40 + 4 + 2 × 30 + 76 + 44', () => {
    expect(phraseLines('Свободный день.\nНе забыть 6 дел.')).toBe(2);
    expect(phraseLines('Пятница свободна.')).toBe(1);
    expect(phraseLines(undefined)).toBe(0);
    expect(weekStripHeight(m)).toBe(14 + 62);
    expect(expandedSheetHeight({ m, meta: true, phraseLines: 2, extra: weekStripHeight(m) })).toBe(10 + 40 + 4 + 60 + 76 + 44);
  });

  it('a title, a back row (48 target), a sub; large text caps the title at ×1.2', () => {
    expect(expandedSheetHeight({ m, title: true })).toBe(10 + 40 + 2 + 34 + 44);
    expect(expandedSheetHeight({ m, back: true, title: true, sub: true })).toBe(10 + 48 + 2 + 34 + 4 + 20 + 44);
    const big = layoutMetricsFor({ width: 384, height: 860, fontScale: 2 });
    expect(expandedSheetHeight({ m: big, meta: true, title: true })).toBe(Math.ceil(10 + 40 + 2 + 40 * 1.2 + 44));
    // The dark sheets are 6 shorter.
    const dark = layoutMetricsFor({ width: 384, height: 860, scheme: 'dark' });
    expect(expandedSheetHeight({ m: dark, title: true })).toBe(10 + 40 + 2 + 34 + 38);
  });

  it('the paper is placed at that height on the very first render (no onLayout needed)', async () => {
    setWindow({ fontScale: 1, width: 384, height: 860 });
    await render(
      <PlaceScreen place="notes" title="Заметки" meta="5 заметок" testID="ps">
        <Text>Строка</Text>
      </PlaceScreen>,
    );
    const H = expandedSheetHeight({ m: layoutMetricsFor({ width: 384, height: 860 }), meta: true, title: true });
    const scroll = screen.getByTestId('ps-scroll');
    expect(StyleSheet.flatten(scroll.props.contentContainerStyle).paddingTop).toBe(H - sheet.overlap);
    expect(StyleSheet.flatten(scroll.props.style).opacity).toBeUndefined();
  });

  it('an extra with no known height: the paper waits hidden for the measure instead of jumping', async () => {
    await render(
      <PlaceScreen place="stone" title="Поиск" sheetExtra={<Text>поле</Text>} testID="ps2">
        <Text>Строка</Text>
      </PlaceScreen>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('ps2-scroll').props.style).opacity).toBe(0);
  });
});

describe('L1: one paint per area', () => {
  it('the bottom fade is one native gradient from the paper at alpha 0', async () => {
    expect(clearOf('#FBF8F2')).toBe('#FBF8F200');
    expect(clearOf('rgba(0,0,0,1)')).toBe('transparent');
    await render(<BottomPaperFade color="#FBF8F2" height={70} />);
  });

  it('in the tabs the screen paints no tray of its own (the root stack has it)', async () => {
    resetApp();
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('page-today') !== null);
    expect(StyleSheet.flatten(screen.getByTestId('page-today').props.style).backgroundColor).toBeUndefined();
  });
});

describe('J3: the strip rides with the keyboard', () => {
  it('still until the keyboard reaches it, then 1:1, ending 8 above it', () => {
    const lift = keyboardLift({ tabsHeight: 68 + 8, gap: 10, aboveKeyboard: 8 });
    expect(rideOffset(0, lift)).toBe(0);
    expect(rideOffset(lift, lift)).toBe(0);
    expect(rideOffset(lift + 100, lift)).toBe(-100);
  });
});

describe('J4: the chat opens at the newest message', () => {
  it('rows newest first, the day header over the first message of each day', () => {
    const msg = (id: string, at: string): ChatMessage => ({ id, role: 'user', text: id, at }) as ChatMessage;
    const rows = chatRows([msg('a', '2026-11-18T10:00:00Z'), msg('b', '2026-11-19T09:00:00Z'), msg('c', '2026-11-19T10:00:00Z')], (iso) => iso.slice(0, 10));
    expect(rows.map((r) => r.m.id)).toEqual(['c', 'b', 'a']);
    expect(rows.map((r) => r.header)).toEqual([false, true, true]);
  });
});

describe('J6: loading is not «Ждёт связи»', () => {
  const task = (id: string, extra: Partial<TaskOut> = {}): TaskOut => ({
    id, client_id: null, item_id: `srv-${id}`, list_key: 'todo', title: id, qty: null, where: null, due_date: null, done: false,
    done_at: null, version: 1, seq: 1, created_at: '2026-11-19T10:00:00Z', updated_at: '2026-11-19T10:00:00Z', deleted_at: null, ...extra,
  });
  const o = { lists: ['todo' as const], today: '2026-11-19' };

  it('while the page rows load, a task with a record waits for its row; one without a record shows', () => {
    const tasks = [task('a'), task('local:b', { item_id: null })];
    expect(listRows(null, tasks, {}, o).open.map((r) => r.task?.id)).toEqual(['local:b']);
    // Loaded and still not on the page: then it is a loose row.
    expect(listRows([], tasks, {}, o).open.map((r) => r.task?.id).sort()).toEqual(['a', 'local:b']);
  });
});

describe('D1: an expense shows its time on the phone clock, not UTC', () => {
  const tz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Asia/Almaty';
  });
  afterAll(() => {
    process.env.TZ = tz;
  });

  it('clockOf: 14:14 UTC is 19:14 in Almaty; nothing for a broken value', () => {
    expect(clockOf('2026-11-19T14:14:00Z')).toBe('19:14');
    expect(clockOf('2026-11-19T19:14:00+05:00')).toBe('19:14');
    expect(clockOf('2026-11-19T02:05:00Z')).toBe('07:05');
    expect(clockOf(null)).toBe('');
    expect(clockOf('нет')).toBe('');
  });

  it('the row of a spending in «Расходы» carries the local time', async () => {
    resetApp();
    finishOnboarding('full');
    const today = localDate(Date.now());
    const at = new Date(Date.now() - 60_000).toISOString();
    const e: ExpenseOut = expenseOut({
      id: 'a', client_id: 'c-a', item_id: 'srv-a', amount: '1500.00', currency: 'KZT', spent_on: today, category_key: 'groceries',
      category_id: 'cat-groceries', direction: 'expense', source: 'form', review_fields: [], version: 1, seq: 1, created_at: at,
      updated_at: at, deleted_at: null,
    })!;
    const cat: ExpenseCategoryOut = expenseCategoryOut({
      id: 'cat-groceries', key: 'groceries', title: 'groceries', title_kk: null, system: true, service: false, position: 'a',
      manual: false, pinned: false, hidden: false, version: 1, seq: 1,
    })!;
    applyServer([e], [cat]);
    const page = usePages.getState().pages.find((p) => p.templateKey === 'expenses')!;
    await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
    await settle(() => screen.queryByTestId('exp-board') !== null);
    if (!screen.queryByTestId('exp-row-a')) {
      await fireEvent.press(screen.getByTestId('exp-bar-groceries'));
      await settle(() => screen.queryByTestId('exp-row-a') !== null);
    }
    const local = clockOf(at);
    expect(local).not.toBe(at.slice(11, 16));
    expect(screen.getByTestId('exp-row-a')).toHaveTextContent(new RegExp(local));
  });
});
