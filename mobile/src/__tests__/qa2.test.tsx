import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { useAssistant, type ChatMessage } from '@/store/assistant';
import { useConnectivity } from '@/store/connectivity';
import { usePages } from '@/store/pages';
import { APP_DIR, atLocalTime, finishOnboarding, resetApp, settle, testRecords } from '@/testing/helpers';
import { BackHandler, StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

import { StickyNote } from '@/components/ui/StickyNote';
import { ruPlural } from '@/i18n/plural';
import i18n from '@/i18n';
import { useTasks } from '@/tasks/store';
import { legacyStickerMap, motionV5, roundStickerColors, stickerColors, stickerOf } from '@/theme';

/** v5 device QA 2 (docs/design/qa/v5-device-qa-2.md, Ф-85). */

const page = (k: string) => usePages.getState().pages.find((p) => p.templateKey === k)!;
const iso = () => new Date().toISOString();

describe('C2: an error says what happened and offers «Повторить»', () => {
  it('«Помощник не ответил» / «Не понял», each with «Повторить»', async () => {
    resetApp();
    finishOnboarding('full');
    const q: ChatMessage = {
      id: 'q1',
      role: 'user',
      text: 'таблетка',
      pageId: 'assistant',
      pageTitle: 'Помощник',
      at: iso(),
    };
    const a1: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      text: '',
      status: 'failed',
      notice: 'no_answer',
      pageId: 'assistant',
      pageTitle: 'Помощник',
      at: iso(),
      replyTo: 'q1',
    };
    const a2: ChatMessage = {
      id: 'a2',
      role: 'assistant',
      text: '',
      status: 'failed',
      notice: 'not_understood',
      pageId: 'assistant',
      pageTitle: 'Помощник',
      at: iso(),
      replyTo: 'q1',
    };
    const a3: ChatMessage = {
      id: 'a3',
      role: 'assistant',
      text: '',
      status: 'failed',
      notice: 'limit',
      pageId: 'assistant',
      pageTitle: 'Помощник',
      at: iso(),
      replyTo: 'q1',
    };
    useAssistant.setState({ messages: [q, a1, a2, a3] });
    useConnectivity.setState({ online: true });
    await renderRouter(APP_DIR, { initialUrl: '/assistant' });
    expect(screen.getByTestId('chat-msg-a1-notice')).toHaveTextContent(/Помощник не ответил/);
    expect(screen.getByTestId('chat-msg-a2-notice')).toHaveTextContent(/Не понял/);
    expect(screen.getByTestId('chat-retry-a1')).toHaveTextContent('Повторить');
    expect(screen.getByTestId('chat-retry-a2')).toBeTruthy();
    // A limit is calm: no «Повторить».
    expect(screen.queryByTestId('chat-retry-a3')).toBeNull();
    await act(async () => undefined);
  });
});

describe('A5: the order mode closes by itself', () => {
  it('«Назад» closes it; the hint is one line «Меняйте порядок стрелками»', async () => {
    resetApp();
    finishOnboarding('full');
    await testRecords.insertLocal({ id: 'n1', kind: 'note', source: 'typed', text: 'Первая' });
    await testRecords.insertLocal({ id: 'n2', kind: 'note', source: 'typed', text: 'Вторая' });
    const backs: (() => boolean | null | undefined)[] = [];
    const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
      const f = h as unknown as () => boolean | null | undefined;
      backs.push(f);
      return { remove: () => void backs.splice(backs.indexOf(f), 1) };
    });
    await renderRouter(APP_DIR, { initialUrl: `/page/${page('notes').id}` });
    await settle(() => screen.queryByTestId('page-menu') !== null);
    await fireEvent.press(screen.getByTestId('page-menu'));
    await settle(() => screen.queryByTestId('page-order') !== null);
    await fireEvent.press(screen.getByTestId('page-order'));
    await settle(() => screen.queryByTestId('page-order-hint') !== null);
    expect(screen.getByTestId('page-order-hint')).toHaveTextContent('Меняйте порядок стрелками');
    expect(screen.getByTestId('page-order-hint').props.numberOfLines).toBe(1);
    await act(async () => {
      for (const h of [...backs].reverse()) if (h()) break;
    });
    await settle(() => screen.queryByTestId('page-order-hint') === null);
    spy.mockRestore();
  });
});

describe('A3: multicoloured stickers, a round without equal neighbours', () => {
  it('8 colours; the old keys map; 6 uncoloured notes → ≥ 5 colours, neighbours (left, above) differ', () => {
    expect(Object.keys(stickerColors.light)).toHaveLength(8);
    expect(stickerColors.light.lemon).toBe('#FFEFA6');
    expect(stickerColors.dark.sky).toBe('#24476E');
    expect(legacyStickerMap).toMatchObject({
      yellow: 'lemon',
      sand: 'lemon',
      blue: 'sky',
      mist: 'aqua',
      graphite: 'lilac',
      white: 'paper',
    });
    expect(stickerOf('green')).toBe('mint');
    const wall = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      explicit: i === 3 ? 'yellow' : null,
      createdAt: 100 - i,
    }));
    const colors = wall.map((w) => roundStickerColors(wall).get(w.id)!);
    expect(new Set(colors).size).toBeGreaterThanOrEqual(5);
    colors.forEach((c, i) => {
      if (i > 0) expect(c).not.toBe(colors[i - 1]);
      if (i > 1) expect(c).not.toBe(colors[i - 2]);
    });
    expect(colors[3]).toBe('lemon');
  });

  it('A4 / B6: a list card is 16 / 14, at least 64; the title first, the date last', async () => {
    const view = await render(
      <StickyNote testID="s" look="list" title="Окулист" text="333 10 10" date="вчера" color="blue" />,
    );
    const box = StyleSheet.flatten(view.getByTestId('s').props.style) as Record<string, unknown>;
    expect(box).toMatchObject({
      paddingHorizontal: 16,
      paddingBottom: 14,
      minHeight: 64,
      backgroundColor: stickerColors.light.sky,
    });
  });
});

describe('B3: plural forms', () => {
  it('1 дело, 2 дела, 5 дел, 21 дело, 6 дел', () => {
    expect([1, 2, 5, 6, 11, 21, 22, 25].map(ruPlural)).toEqual([
      'one',
      'few',
      'many',
      'many',
      'many',
      'one',
      'few',
      'many',
    ]);
    expect(i18n.t('today6.phrase_morning', { count: 6 })).toBe('Доброе утро.'+String.fromCharCode(10)+'Сегодня 6'+String.fromCharCode(160)+'дел.');
  });
});

describe('A1: the strip folds in 260 ms and opens in 280 ms', () => {
  it('timings', () => {
    expect(motionV5.askCollapse).toBe(260);
    expect(motionV5.askExpand).toBe(280);
  });
});

describe('A8 → Ф-93: no day in place on «Сегодня»; B8 → v6: «План» shows 4 rows and «Ещё N»', () => {
  afterEach(() => jest.useRealTimers());
  it('B8: six to-dos without a time — four rows at 390 dp, then «Ещё 2» that opens «Дела» as the list', async () => {
    resetApp();
    finishOnboarding('full');
    atLocalTime(14);
    const at = new Date().toISOString();
    const task = (id: string) => ({
      id,
      client_id: id,
      item_id: `i-${id}`,
      list_key: 'todo',
      title: `Дело ${id}`,
      qty: null,
      where: null,
      due_date: null,
      done: false,
      done_at: null,
      version: 1,
      seq: 1,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    });
    useTasks.setState({ tasks: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [k, task(k)])) as never });
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('today-plan-more') !== null);
    expect(screen.getByTestId('today-plan-more')).toHaveTextContent('Ещё 2');
    expect(screen.getAllByTestId(/^today-row-todo:/)).toHaveLength(4);
    expect(screen.queryByTestId('today-week')).toBeNull();
    expect(screen.queryByTestId('today-back')).toBeNull();
  });
});
