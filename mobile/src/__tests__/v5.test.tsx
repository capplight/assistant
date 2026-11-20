import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import '@/i18n';
import { PlaceScreen, sheetFits, sheetInset } from '@/components/ui/PlaceScreen';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { ButtonRow } from '@/components/ui/Leaf';
import { ASK_SCROLL_START, askScrollStep, type AskScrollState } from '@/store/chrome';
import { resetWindow, setWindow } from '@/testing/layoutAudit';
import { darkColors, layoutMetricsFor, legacyStickerMap, lightColors, PLACE_KEYS, stickerColors, stickerInk, stickerOf, type ColorTokens } from '@/theme';
import { firstSteps, withoutLastWord } from '@/today/empty';

/** v5 «Листы» (Ф-79, tokens-v5.ts, design-system §11): adaptive metrics, the strip rules, the day plan, colours. */

afterEach(() => resetWindow());

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe('useLayoutMetrics (layoutMetricsFor)', () => {
  it('gutters 16 / 20 / 24 and the phrase 23 / 27 / 30, 25 in dark', () => {
    expect(layoutMetricsFor({ width: 320, height: 640 })).toMatchObject({ size: 'small', gutter: 16, phraseSize: 23, titleOnly: true });
    expect(layoutMetricsFor({ width: 375, height: 780 })).toMatchObject({ size: 'regular', gutter: 20, phraseSize: 27, titleOnly: false });
    expect(layoutMetricsFor({ width: 390, height: 844, scheme: 'dark' })).toMatchObject({ gutter: 20, phraseSize: 25, sheetPadBottom: 38 });
    expect(layoutMetricsFor({ width: 430, height: 932 })).toMatchObject({ size: 'large', gutter: 24, phraseSize: 30 });
  });

  it('font ≥ 1.3: title only, the plan as rows, rows 68, the strip 56 with 78 of room', () => {
    const m = layoutMetricsFor({ width: 390, height: 844, fontScale: 1.3 });
    expect(m).toMatchObject({ largeText: true, titleOnly: true, planAsRows: true, row: 68, checkbox: 32 });
    expect(m.ask).toMatchObject({ height: 56, radius: 28, mic: 44, fontSize: 19, listBottomPadding: 78 });
    expect(layoutMetricsFor({ width: 390, height: 844, fontScale: 1.2 }).ask).toMatchObject({ height: 48, listBottomPadding: 70 });
  });

  it('tab labels 12 (11.5 at ≤ 340) never above 13; capsules 46/58 (42/52 small)', () => {
    for (const [w, label, cap, active] of [
      [320, 11.5, 42, 52],
      [390, 12, 46, 58],
    ] as const) {
      const t = layoutMetricsFor({ width: w, height: 800, fontScale: 2 }).tab;
      expect(t).toMatchObject({ labelSize: label, capsule: cap, capsuleActive: active });
      expect(t.labelSize * t.labelMaxScale).toBeCloseTo(13);
    }
  });

  it('the strip insets 8 / 12 / 16 and the safe areas (a 3-button bar gives its inset, none = 8)', () => {
    expect(layoutMetricsFor({ width: 320, height: 640 }).ask.inset).toBe(8);
    expect(layoutMetricsFor({ width: 390, height: 844 }).ask.inset).toBe(12);
    expect(layoutMetricsFor({ width: 430, height: 932 }).ask.inset).toBe(16);
    expect(layoutMetricsFor({ width: 390, height: 844, insets: { top: 47, bottom: 34, left: 0, right: 0 } })).toMatchObject({ top: 47, bottom: 34 });
    expect(layoutMetricsFor({ width: 390, height: 844, insets: { top: 0, bottom: 0, left: 0, right: 0 } })).toMatchObject({ top: 20, bottom: 8 });
  });
});

describe('the assistant strip folds (Ф-82, askScrollStep)', () => {
  const run = (ys: number[], o: { content?: number; viewport?: number; pinned?: boolean } = {}) =>
    ys.reduce<AskScrollState>((st, y) => askScrollStep(st, { y, contentHeight: o.content ?? 2000, viewportHeight: o.viewport ?? 600, pinned: !!o.pinned }), ASK_SCROLL_START);

  it('folds after more than 24 dp of continuous downward scroll, not at the very top', () => {
    expect(run([10, 20]).collapsed).toBe(false);
    expect(run([10, 30, 50]).collapsed).toBe(true);
    expect(run([5, 15, 22]).collapsed).toBe(false);
  });

  it('opens at once on more than 24 dp up and near the end; never folds when pinned or when the list fits', () => {
    expect(run([10, 30, 60, 100, 85]).collapsed).toBe(true);
    expect(run([10, 30, 60, 100, 85, 70]).collapsed).toBe(false);
    expect(run([10, 30, 60, 1390]).collapsed).toBe(false);
    expect(run([10, 30, 60, 100], { pinned: true }).collapsed).toBe(false);
    expect(run([10, 30, 60, 100], { content: 500 }).collapsed).toBe(false);
  });
});

describe('colours (tokens-v5)', () => {
  it.each([
    ['light', lightColors],
    ['dark', darkColors],
  ] as const)('%s: AA for ink / ink2 / ink3 on paper and paper2, onSheet on the places', (_n, c: ColorTokens) => {
    for (const bg of [c.paper, c.paper2]) for (const fg of [c.ink, c.ink2, c.ink3]) expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    for (const p of PLACE_KEYS) {
      const ink = p === 'stone' ? c.onStone : c.onSheet;
      // Terracotta: large text only (≥ 3 : 1); every other sheet AA.
      expect(contrast(ink, c.place[p])).toBeGreaterThanOrEqual(p === 'assistant' ? 3 : 4.5);
    }
    expect(contrast(c.trayInk2, c.tray)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.assistantText, c.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.noticeInk, c.noticeBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.onBtn, c.btn)).toBeGreaterThanOrEqual(4.5);
    expect(c.a4).toBe('#FFFFFF');
  });

  it('A8 (Ф-84): the dark paper stands apart from the tray, and a paper sticker from the paper', () => {
    expect(darkColors.paper).toBe('#26252B');
    expect(contrast(darkColors.paper, darkColors.tray)).toBeGreaterThanOrEqual(1.25);
    expect(stickerColors.dark.paper).not.toBe(darkColors.paper);
    expect(stickerColors.dark.paper).not.toBe(darkColors.paper2);
  });

  it('ink3 is #6B6774 in light; stickers keep their text AA; old keys map to the new stickers', () => {
    expect(lightColors.ink3).toBe('#6B6774');
    for (const scheme of ['light', 'dark'] as const)
      for (const fill of Object.values(stickerColors[scheme])) expect(contrast(stickerInk[scheme].ink2, fill)).toBeGreaterThanOrEqual(4.5);
    // Ф-85 (tokens-v5 `legacyStickerMap`): v2 keys and the Ф-79 keys → the 8 colours.
    expect(legacyStickerMap).toEqual({ white: 'paper', yellow: 'lemon', peach: 'apricot', pink: 'rose', lilac: 'lilac', blue: 'sky', green: 'mint', sand: 'lemon', mist: 'aqua', graphite: 'lilac' });
    expect(stickerOf('green')).toBe('mint');
    expect(stickerOf('sand')).toBe('lemon');
    expect(stickerOf(null)).toBe('paper');
  });
});

describe('PlaceScreen', () => {
  it('the phrase on a regular phone; only the title at 320 dp and at font 1.3', async () => {
    const ui = () => (
      <PlaceScreen place="today" title="Сегодня" meta="Вторник, 17 ноября" phrase={'Спокойный день.\n5 дел, 1 встреча.'} titleTestID="t">
        <Text>План дня</Text>
      </PlaceScreen>
    );
    setWindow({ fontScale: 1, width: 390, height: 844 });
    await render(ui());
    expect(screen.getByTestId('sheet-phrase')).toHaveTextContent(/Спокойный день/);
    expect(screen.getByTestId('sheet-phrase').props.numberOfLines).toBe(2);
    setWindow({ fontScale: 1, width: 320, height: 640 });
    await render(ui());
    expect(screen.queryByTestId('sheet-phrase')).toBeNull();
    expect(screen.getByTestId('t')).toHaveTextContent('Сегодня');
    setWindow({ fontScale: 1.3, width: 390, height: 844 });
    await render(ui());
    expect(screen.queryByTestId('sheet-phrase')).toBeNull();
  });
});

describe('device QA 1 (docs/design/qa/v5-device-qa-1.md): layout rules', () => {
  it('A1/A2: the first element starts 18 below the visible paper edge; the strip is 6 / 44 / 6 (+ the 28 overlap)', () => {
    expect(sheetInset(150)).toBe(150 - 28 + 18);
    const m = layoutMetricsFor({ width: 384, height: 860 });
    expect(m.collapsedSheet).toBe(6 + 44 + 6 + 28);
    expect(layoutMetricsFor({ width: 384, height: 860, scheme: 'dark' }).collapsedSheet).toBe(84);
    // The list under a collapsed sheet starts at its own height, not the expanded one (A3).
    expect(sheetInset(m.collapsedSheet)).toBe(56 + 18);
  });

  it('A4: content that fits once collapsed does not keep the sheet collapsed', () => {
    expect(sheetFits(700, 600, 120)).toBe(true);
    expect(sheetFits(900, 600, 120)).toBe(false);
  });

  it('A6: button and chip labels never wrap; two buttons stack in a wrapping row', async () => {
    await render(
      <ButtonRow testID="pair">
        <Button testID="b1" label="Не удалять" variant="secondary" onPress={() => undefined} />
        <Button testID="b2" label="Удалить навсегда" onPress={() => undefined} />
      </ButtonRow>,
    );
    expect(screen.getByText('Не удалять').props.numberOfLines).toBe(1);
    expect(StyleSheet.flatten(screen.getByTestId('pair').props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    await render(<Chip label="Пропущено 2" onPress={() => undefined} />);
    expect(screen.getByText('Пропущено 2').props.numberOfLines).toBe(1);
    expect(StyleSheet.flatten(screen.getByText('Пропущено 2').props.style).flexShrink).toBe(0);
  });
});

describe('Ф-84 empty «Сегодня»: the first steps (the phrase is today-v6 §3.1, `today/timeOfDay.ts`)', () => {
  it('«Три первые фразы»: the first 7 days until three records exist; the phrase goes in without its last word', () => {
    expect(firstSteps({ ageDays: 1, note: true, reminder: false, expense: false })).toEqual({ show: true, done: 1 });
    expect(firstSteps({ ageDays: 1, note: true, reminder: true, expense: true }).show).toBe(false);
    expect(firstSteps({ ageDays: 7.5, note: false, reminder: false, expense: false }).show).toBe(false);
    expect(withoutLastWord('Запомни: код домофона 4512')).toBe('Запомни: код домофона ');
    expect(withoutLastWord('Такси')).toBe('Такси');
  });
});
