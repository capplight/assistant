import { render } from '@testing-library/react-native';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { addSharedTurn } from '@/chat/service';
import { VoicePlayer, waveOf } from '@/components/RecordMedia';
import { answerBody, siteOf } from '@/components/WebSources';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { useConnectivity } from '@/store/connectivity';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';

/** Mobile leftovers pixel-fit to screens-v5-extra.html (task editor, voice, preview, shared link, web sources, imports). */

const iso = () => new Date().toISOString();

beforeEach(() => {
  resetApp();
  finishOnboarding('full');
});

describe('«Дело · редактор»: the time wheel and the calendar (no ±1:00 / ±0:05)', () => {
  it('the wheel turns the hour and the minutes by 5; «Другой день» opens the month, «Готово» picks the day', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/reminder-new?text=Позвонить' });
    expect(screen.queryByTestId('rem-hour-plus')).toBeNull();
    expect(screen.getByTestId('rem-wheel')).toBeTruthy();
    const before = String(screen.getByTestId('rem-time', { includeHiddenElements: true }).props.children);
    await fireEvent(screen.getByTestId('rem-wheel-hour'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    const [h0, m0] = before.split(':').map(Number);
    expect(String(screen.getByTestId('rem-time', { includeHiddenElements: true }).props.children)).toBe(
      `${String((h0! + 1) % 24).padStart(2, '0')}:${String(m0).padStart(2, '0')}`,
    );
    await fireEvent(screen.getByTestId('rem-wheel-minute'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(String(screen.getByTestId('rem-time', { includeHiddenElements: true }).props.children)).toMatch(
      /:(05|10|15|20|25|30|35|40|45|50|55|00)$/,
    );
    await fireEvent.press(screen.getByTestId('rem-other-day'));
    await settle(() => screen.queryByTestId('cal-sheet') !== null);
    await fireEvent.press(screen.getByTestId('cal-quick-week'));
    expect(screen.getByTestId('cal-done')).toHaveTextContent(/^Готово · /);
    await fireEvent.press(screen.getByTestId('cal-done'));
    await settle(() => screen.queryByTestId('cal-sheet') === null);
    expect(screen.getByTestId('rem-other-day').props.accessibilityState.selected).toBe(true);
  });
});

describe('«Запись · голосовая»: the player with the waveform', () => {
  it('a steady wave; ▶ plays and shows the length', async () => {
    expect(waveOf('abc')).toEqual(waveOf('abc'));
    expect(waveOf('abc')).toHaveLength(22);
    expect(Math.max(...waveOf('abc'))).toBeLessThanOrEqual(28);
    const view = await render(
      <VoicePlayer
        files={[{ uri: 'file:///v.m4a', mime: 'audio/m4a', bytes: 10, sha256: 'ff00', durationMs: 14_000 }]}
      />,
    );
    expect(view.getByTestId('record-voice-time')).toHaveTextContent('0:14');
    expect(view.getByTestId('record-voice-play').props.accessibilityLabel).toBe('Прослушать, 0:14');
    await fireEvent.press(view.getByTestId('record-voice-play'));
    const audio = jest.requireMock('expo-audio') as { __player: { play: jest.Mock } };
    expect(audio.__player.play).toHaveBeenCalled();
  });
});

describe('web_sources (Ф-87): links under the answer, no doubled «Источники: …» line', () => {
  it('the trailing line goes only when the event came; links show the site', async () => {
    expect(
      answerBody({
        text: 'Срок — 10 дней.\nИсточники: zakon.kz, egov.kz',
        webSources: [{ url: 'https://zakon.kz/a', title: null }],
      }),
    ).toBe('Срок — 10 дней.');
    expect(answerBody({ text: 'Срок — 10 дней.\nИсточники: zakon.kz', webSources: undefined })).toBe(
      'Срок — 10 дней.\nИсточники: zakon.kz',
    );
    expect(siteOf('https://www.Zakon.kz/news/1')).toBe('zakon.kz');
    const q: ChatMessage = {
      id: 'q',
      role: 'user',
      text: 'срок замены удостоверения',
      pageId: 'assistant',
      pageTitle: 'Помощник',
      at: iso(),
    };
    const a: ChatMessage = {
      id: 'a',
      role: 'assistant',
      text: 'Обычно 10 рабочих дней.\nИсточники: egov.kz',
      status: 'done',
      pageId: 'assistant',
      pageTitle: 'Помощник',
      at: iso(),
      replyTo: 'q',
      webSources: [{ url: 'https://egov.kz/cms/ru', title: 'eGov' }],
    };
    useAssistant.setState({ messages: [q, a] });
    useConnectivity.setState({ online: true });
    await renderRouter(APP_DIR, { initialUrl: '/assistant' });
    expect(screen.getByTestId('chat-msg-a-text')).toHaveTextContent('Обычно 10 рабочих дней.');
    expect(screen.getByTestId('chat-msg-a-text')).not.toHaveTextContent(/Источники/);
    expect(screen.getByTestId('web-source-0')).toHaveTextContent('egov.kz');
  });
});

describe('«Поделились ссылкой»: a shared link is a card of the person in the chat', () => {
  it('video link → «видео по ссылке · вы поделились», the saved line under it', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/assistant' });
    let id = '';
    await act(async () => {
      id = addSharedTurn({ id: 'r1', url: 'https://youtu.be/xyz', title: '10 мест в Стамбуле', text: null });
    });
    const question = useAssistant.getState().messages.find((m) => m.role === 'user')!;
    expect(question.shared).toEqual({ kind: 'video', recordId: 'r1', url: 'https://youtu.be/xyz' });
    await settle(() => screen.queryByTestId(`chat-user-${question.id}-shared`) !== null);
    expect(screen.getByTestId(`chat-user-${question.id}-shared`)).toHaveTextContent(
      /видео по ссылке · вы поделились.*10 мест в Стамбуле/,
    );
    expect(useAssistant.getState().messages.find((m) => m.id === id)?.saved).toBe(true);
  });
});

describe('imports: steps in circles, the progress plate', () => {
  it('Telegram: four steps numbered in circles', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/import' });
    await settle(() => screen.queryByTestId('import-steps') !== null);
    for (const n of [1, 2, 3, 4]) expect(screen.getByTestId(`import-steps-${n}`)).toBeTruthy();
    expect(screen.getByTestId('import-steps-2')).toHaveTextContent(/Экспорт истории чата/);
  });
});
