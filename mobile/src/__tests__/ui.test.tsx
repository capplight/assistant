import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react-native';
import { Bell, Search, Settings, StickyNote as StickyIcon, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import '@/i18n';
import {
  ActionList,
  AppText,
  Button,
  Card,
  CheckCircle,
  CheckRow,
  Chip,
  EmptyState,
  Header,
  ListGroup,
  ListRow,
  ResponsiveGrid,
  SegmentedControl,
  Sheet,
  StickyNote,
  TabBar,
  ToastBar,
} from '@/components/ui';
import { auditLayout, AUDIT_MATRIX, resetWindow, setWindow } from '@/testing/layoutAudit';
import {
  darkColors,
  darkNoteColors,
  gridItemWidth,
  layoutFor,
  lightColors,
  lightNoteColors,
  noteColumnsFor,
  tileColumnsFor,
  useLayout,
  useSchemePreference,
  useTheme,
  type ColorTokens,
} from '@/theme';

/** «Мята / Глубина» foundation (design-system §2–§4): tokens, the layout toolkit, the UI kit at every width. */

afterEach(() => {
  resetWindow();
  useSchemePreference.getState().set('system');
});

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

describe('colour roles: WCAG contrast in both themes', () => {
  it.each([
    ['light', lightColors, lightNoteColors],
    ['dark', darkColors, darkNoteColors],
  ] as const)('%s', async (_n, c: ColorTokens, notes) => {
    for (const bg of [c.bg, c.surface]) {
      expect(contrast(c.ink, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.ink2, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.brand, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.danger, c.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.iconSecondary, c.surface)).toBeGreaterThanOrEqual(3);
    }
    // ink3 only on surface.
    expect(contrast(c.ink3, c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.onBrand, c.brand)).toBeGreaterThanOrEqual(5.5);
    expect(contrast(c.onHighlight, c.highlight)).toBeGreaterThanOrEqual(7);
    // Tonal chips / secondary buttons: brand text on its tint (tints tuned from tokens.ts to reach AA).
    expect(contrast(c.brand, c.brandTint)).toBeGreaterThanOrEqual(4.5);
    for (const fill of Object.values(notes)) expect(contrast(c.ink, fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('follows the phone, and the override wins', async () => {
    const { result } = await renderHook(() => useTheme());
    expect(result.current.scheme).toBe('light');
    expect(result.current.elevation.card).not.toBeNull();
    await act(async () => useSchemePreference.getState().set('dark'));
    expect(result.current.scheme).toBe('dark');
    expect(result.current.colors.bg).toBe(darkColors.bg);
    // Dark: no card shadows, floating ones stay.
    expect(result.current.elevation.card).toBeNull();
    expect(result.current.elevation.floating.shadowOpacity).toBe(0.35);
  });
});

describe('layout toolkit', () => {
  it('width classes, gutters and the readable column', async () => {
    expect(layoutFor({ width: 320, height: 568 })).toMatchObject({ widthClass: 'compact', gutter: 12, contentWidth: 296 });
    expect(layoutFor({ width: 360, height: 780 })).toMatchObject({ widthClass: 'regular', gutter: 16 });
    expect(layoutFor({ width: 412, height: 915 })).toMatchObject({ widthClass: 'regular', gutter: 16, twoPane: false });
    expect(layoutFor({ width: 600, height: 960 })).toMatchObject({ widthClass: 'expanded', gutter: 20, tablet: true });
    const big = layoutFor({ width: 1280, height: 800 });
    expect(big).toMatchObject({ widthClass: 'expanded', twoPane: true, landscape: true, contentWidth: 600 });
    // Safe areas eat into the width (landscape notch).
    expect(layoutFor({ width: 844, height: 390, insets: { top: 0, bottom: 21, left: 47, right: 47 } }).contentWidth).toBe(600);
    expect(layoutFor({ width: 640, height: 360, insets: { top: 0, bottom: 0, left: 40, right: 40 } }).contentWidth).toBe(520);
  });

  it('font scale is clamped to 2.0; ≥1.5 is large font', async () => {
    expect(layoutFor({ width: 390, height: 844, fontScale: 3.1 }).fontScale).toBe(2);
    expect(layoutFor({ width: 390, height: 844, fontScale: 1.5 }).largeFont).toBe(true);
    expect(layoutFor({ width: 390, height: 844, fontScale: 1.3 }).largeFont).toBe(false);
  });

  it('sticky-note columns: 2 · 3 from 600 · 1 at ≥150 % · 1 under 360 from 130 %', async () => {
    expect(noteColumnsFor(390, 1)).toBe(2);
    expect(noteColumnsFor(600, 1)).toBe(3);
    expect(noteColumnsFor(840, 1.3)).toBe(3);
    expect(noteColumnsFor(840, 2)).toBe(1);
    expect(noteColumnsFor(320, 1)).toBe(2);
    expect(noteColumnsFor(320, 1.3)).toBe(1);
    expect(noteColumnsFor(360, 1.3)).toBe(2);
  });

  it('tile columns and cell widths', async () => {
    expect(tileColumnsFor(296, 1)).toBe(1);
    expect(tileColumnsFor(358, 1)).toBe(2);
    expect(tileColumnsFor(600, 1)).toBe(3);
    expect(tileColumnsFor(600, 2)).toBe(2);
    expect(gridItemWidth(358, 2, 8)).toBe(175);
    expect(gridItemWidth(600, 3, 8)).toBe(194);
    expect(gridItemWidth(100, 0)).toBe(100);
  });

  it('useLayout follows the window', async () => {
    setWindow({ fontScale: 1.3, width: 320, height: 568 });
    const { result } = await renderHook(() => useLayout());
    expect(result.current).toMatchObject({ widthClass: 'compact', noteColumns: 1, fontScale: 1.3 });
    setWindow({ fontScale: 1, width: 840, height: 1180 });
    const again = await renderHook(() => useLayout());
    expect(again.result.current).toMatchObject({ widthClass: 'expanded', twoPane: true, noteColumns: 3 });
  });
});

const LONG_KK = 'Ертең сағат 10:00-де Ғалымға қоңырау шалу, құжаттарды және шартты ұмытпаңыз — бұл өте маңызды жазба';

/** Every kit component in one screen, with long Kazakh text (the widest strings we have). */
function Gallery() {
  const [seg, setSeg] = useState<'today' | 'soon' | 'missed'>('today');
  const [done, setDone] = useState(false);
  return (
    <View>
      <Header
        testID="g-header"
        title="Жоспарлар және тапсырмалар тізімі"
        meta="13 қараша"
        back={{ onPress: () => undefined }}
        actions={[
          { key: 's', icon: Search, label: 'Іздеу', onPress: () => undefined },
          { key: 'm', icon: Settings, label: 'Тағы', onPress: () => undefined },
        ]}
      >
        <SegmentedControl
          testID="g-seg"
          value={seg}
          onChange={setSeg}
          segments={[
            { key: 'today', label: 'Бүгін', count: 4 },
            { key: 'soon', label: 'Жақында', count: 12 },
            { key: 'missed', label: 'Өткізіп алынған', count: 1 },
          ]}
        />
      </Header>
      <Card>
        <AppText>{LONG_KK}</AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button label="Дайын" onPress={() => undefined} />
          <Button label="Кейінге қалдыру" variant="secondary" onPress={() => undefined} />
          <Button label="Жою" variant="text" labelColor="danger" onPress={() => undefined} />
        </View>
      </Card>
      <ListGroup title="Сіздің беттеріңіз">
        <ListRow title={LONG_KK} meta="Бүгін, 14:30" left={<CheckCircle checked={done} onChange={setDone} label={LONG_KK} />} />
        <ListRow title="Баптаулар" icon={Settings} chevron onPress={() => undefined} />
        <ListRow title="Жою" icon={Trash2} danger onPress={() => undefined} value="1 240 000 ₸" />
      </ListGroup>
      <CheckRow label={LONG_KK} checked={false} onChange={() => undefined} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Chip label="Айтыңыз: сүт сатып алу" onPress={() => undefined} />
        <Chip label="Барлығы" variant="selected" onPress={() => undefined} />
        <Chip label="Жұмыс" variant="neutral" />
      </View>
      <ResponsiveGrid testID="g-grid">
        <StickyNote title="Сатып алу" text={LONG_KK} date="8 қар." color="yellow" pinned />
        <StickyNote text={LONG_KK} date="2 қар." color="white" />
        <StickyNote text="ОСАГО: 12 наурызға дейін" color="green" />
      </ResponsiveGrid>
      <EmptyState icon={StickyIcon} text={LONG_KK} example={{ label: 'Айтыңыз: сүт сатып алу', onPress: () => undefined }} />
      <ToastBar
        text="Дела бетіне сақтадым: сүт, нан, жұмыртқа және тағы төрт жол"
        success
        actions={[
          { key: 'show', label: 'Көрсету', onPress: () => undefined },
          { key: 'undo', label: 'Болдырмау', onPress: () => undefined },
        ]}
        onClose={() => undefined}
      />
      <TabBar
        tabs={[
          { key: 'today', label: 'Бүгін', icon: Bell, active: true, onPress: () => undefined },
          { key: 'notes', label: 'Жазбалар', icon: StickyIcon, active: false, onPress: () => undefined },
          { key: 'tasks', label: 'Істер мен еске салғыштар', icon: Bell, active: false, onPress: () => undefined },
          { key: 'more', label: 'Тағы', icon: Settings, active: false, onPress: () => undefined },
        ]}
      />
    </View>
  );
}

describe('the kit at every width × font scale (320 / 360 / 412 / 600 / 840 × 1.0 / 1.3 / 2.0)', () => {
  it.each(AUDIT_MATRIX.map((w) => [`${w.width} @ ${w.fontScale}`, w] as const))('%s', async (_n, w) => {
    setWindow(w);
    await render(<Gallery />);
    expect(auditLayout(screen.toJSON(), { windowWidth: w.width })).toEqual([]);
    // Grid columns follow the layout rules.
    const grid = screen.getByTestId('g-grid');
    expect(grid.children).toHaveLength(noteColumnsFor(w.width, w.fontScale));
    // Segments stack at ≥150 %; the tab bar never gets wider than 600.
    expect(StyleSheet.flatten(screen.getByTestId('g-seg').props.style).flexDirection).toBe(w.fontScale >= 1.5 ? 'column' : 'row');
    expect(StyleSheet.flatten(screen.getByTestId('bottom-tabs').props.style).maxWidth).toBe(600);
  });
});

describe('components', () => {
  it('Button: primary / secondary / text, disabled, ≥48 target', async () => {
    const onPress = jest.fn();
    await render(
      <View>
        <Button testID="b1" label="Начать" onPress={onPress} />
        <Button testID="b2" label="Позже" variant="secondary" onPress={onPress} disabled />
        <Button testID="b3" label="Отменить" variant="text" onPress={onPress} />
      </View>,
    );
    await fireEvent.press(screen.getByTestId('b1'));
    await fireEvent.press(screen.getByTestId('b2'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('b2')).toBeDisabled();
    const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style);
    expect(flat('b1')).toMatchObject({ minHeight: 50, backgroundColor: lightColors.brand, borderRadius: 9999 });
    expect(flat('b2')).toMatchObject({ backgroundColor: lightColors.brandTint, opacity: 0.4 });
    expect(flat('b3').minHeight).toBe(48);
    expect(screen.getByText('Начать')).toHaveStyle({ fontSize: 17, color: lightColors.onBrand });
  });

  it('CheckCircle: 24 circle in a 48 target, toggles, announces state', async () => {
    function T() {
      const [on, setOn] = useState(false);
      return <CheckCircle testID="c" checked={on} onChange={setOn} label="Купить молоко" />;
    }
    await render(<T />);
    const c = screen.getByTestId('c');
    expect(c).not.toBeChecked();
    expect(StyleSheet.flatten(c.props.style)).toMatchObject({ width: 48, height: 48 });
    await fireEvent.press(c);
    expect(screen.getByTestId('c')).toBeChecked();
  });

  it('SegmentedControl: tabs with counts inside the label', async () => {
    const onChange = jest.fn();
    await render(
      <SegmentedControl
        value="a"
        onChange={onChange}
        segments={[
          { key: 'a', label: 'Сегодня', count: 4, testID: 's-a' },
          { key: 'b', label: 'Скоро', testID: 's-b' },
        ]}
      />,
    );
    expect(screen.getByText('Сегодня · 4')).toBeTruthy();
    expect(screen.getByTestId('s-a')).toBeSelected();
    await fireEvent.press(screen.getByTestId('s-b'));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('Sheet + ActionList: rows, danger, visible «Закрыть» and the scrim close it', async () => {
    const onClose = jest.fn();
    const del = jest.fn();
    await render(
      <Sheet visible onClose={onClose} title="Запись" testID="sh">
        <ActionList
          actions={[
            { key: 'move', label: 'Переложить', onPress: () => undefined, testID: 'a-move' },
            { key: 'del', label: 'Удалить', danger: true, icon: Trash2, onPress: del, testID: 'a-del' },
          ]}
        />
      </Sheet>,
    );
    expect(within(screen.getByTestId('sh')).getByText('Запись')).toBeTruthy();
    expect(screen.getByText('Удалить')).toHaveStyle({ color: lightColors.danger });
    await fireEvent.press(screen.getByTestId('a-del'));
    expect(del).toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('sh-close'));
    await fireEvent.press(screen.getByTestId('sh-scrim', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(StyleSheet.flatten(screen.getByTestId('sh').props.style)).toMatchObject({ maxWidth: 600, borderTopLeftRadius: 24 });
  });

  it('Header: «‹ Назад», largeTitle, ≤2 round buttons', async () => {
    const back = jest.fn();
    await render(<Header title="Поиск" back={{ onPress: back }} actions={[{ key: 's', icon: Search, label: 'Искать', onPress: () => undefined, testID: 'h-s' }]} />);
    await fireEvent.press(screen.getByTestId('header-back'));
    expect(back).toHaveBeenCalled();
    expect(screen.getByText('Назад')).toHaveStyle({ color: lightColors.brand });
    expect(screen.getByRole('header', { name: 'Поиск' })).toHaveStyle({ fontSize: 30 });
    expect(screen.getByLabelText('Искать')).toBeTruthy();
  });

  it('ListGroup: inset dividers between rows, none after the last', async () => {
    await render(
      <ListGroup>
        <ListRow testID="r1" title="Один" />
        <ListRow testID="r2" title="Два" />
      </ListGroup>,
    );
    const divider = (id: string) => {
      const box = screen.getByTestId(id).children[0] as unknown as { children: { props: { style: unknown } }[] };
      return StyleSheet.flatten(box.children[0]!.props.style as never) as { borderBottomWidth?: number };
    };
    expect(divider('r1').borderBottomWidth).toBeGreaterThan(0);
    expect(divider('r2').borderBottomWidth).toBeUndefined();
  });

  it('StickyNote: note fill, long press opens the menu, 8-line preview', async () => {
    const onLong = jest.fn();
    await render(<StickyNote testID="n" text="Купить молоко" color="green" onLongPress={onLong} pinned />);
    expect(StyleSheet.flatten(screen.getByTestId('n').props.style)).toMatchObject({ backgroundColor: lightNoteColors.green, borderRadius: 14 });
    await fireEvent(screen.getByTestId('n'), 'longPress');
    expect(onLong).toHaveBeenCalled();
    expect(screen.getByText('Купить молоко').props.numberOfLines).toBe(8);
  });

  it('EmptyState and ToastBar', async () => {
    const ex = jest.fn();
    const undo = jest.fn();
    const close = jest.fn();
    await render(
      <View>
        <EmptyState icon={StickyIcon} text="Здесь пока пусто" example={{ label: 'Скажите: купить молоко', onPress: ex }} />
        <ToastBar testID="t" text="Сохранил в Дела" success actions={[{ key: 'u', label: 'Отменить', onPress: undo, testID: 't-undo' }]} onClose={close} />
      </View>,
    );
    await fireEvent.press(screen.getByText('Скажите: купить молоко'));
    await fireEvent.press(screen.getByTestId('t-undo'));
    await fireEvent.press(screen.getByLabelText('Закрыть'));
    expect([ex, undo, close].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(StyleSheet.flatten(screen.getByTestId('t').props.style)).toMatchObject({ borderRadius: 20, minHeight: 48 });
  });

  it('TabBar: tablist, selected tab, brand pill', async () => {
    const go = jest.fn();
    await render(
      <TabBar
        tabs={[
          { key: 'a', label: 'Сегодня', icon: Bell, active: true, onPress: go },
          { key: 'b', label: 'Ещё', icon: Settings, active: false, onPress: go },
        ]}
      />,
    );
    expect(screen.getByTestId('tab-a')).toBeSelected();
    expect(screen.getByTestId('tab-b')).not.toBeSelected();
    await fireEvent.press(screen.getByTestId('tab-b'));
    expect(go).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Сегодня')).toHaveStyle({ color: lightColors.brand });
  });
});
