import type { JsonElement, JsonNode } from 'test-renderer';
import { Dimensions, PixelRatio, StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

/**
 * Week 17: the 200% rule (2-design §8 «Шрифт до 200%», F-22). Structural checks of a rendered screen,
 * no snapshots: what would clip, overlap or cut a value when the system font is 200% on a 320 pt
 * phone. Jest has no text layout, so this checks the props that decide it on a device:
 *
 * - `clipped-value`   a Text with `numberOfLines` that is a money value or a time line (≤40 letters), or the «ИИ» label;
 * - `fixed-height`    a View with a fixed `height` / `maxHeight` around text (text grows, the box does not);
 * - `fixed-input`     a TextInput with a fixed `height`;
 * - `no-scale`        a Text that does not scale (`allowFontScaling={false}`, `maxFontSizeMultiplier` < 1.5)
 *                     unless hidden from screen readers (a drawn thumbnail) or allowed by the caller;
 * - `row-of-buttons`  ≥3 buttons with words side by side, no `flexWrap` and no sideways scroll
 *                     (2-design §8: «при ≥150% ряды становятся вертикальными списками»);
 * - `small-target`    a button with a fixed height or width under 48;
 * - `too-wide`        a View with a fixed width wider than the window.
 */

export type Rule = 'clipped-value' | 'fixed-height' | 'fixed-input' | 'no-scale' | 'row-of-buttons' | 'small-target' | 'too-wide';
export type Violation = { rule: Rule; where: string; detail: string };
/** Allowed exceptions: a rule for nodes whose testID (or an ancestor's) matches, with the reason. */
export type Allow = { rule: Rule; testID: RegExp; why: string };

export const NARROW = { width: 320, height: 568 };

/** The window the app sees: `useWindowDimensions().fontScale`, `PixelRatio.getFontScale()` and the width. */
export function setWindow(o: { fontScale: number; width?: number; height?: number }): void {
  const dims = { width: o.width ?? 390, height: o.height ?? 844, scale: 2, fontScale: o.fontScale };
  Dimensions.set({ window: dims, screen: dims });
  jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(o.fontScale);
}

export function resetWindow(): void {
  const dims = { width: 390, height: 844, scale: 3, fontScale: 1 };
  Dimensions.set({ window: dims, screen: dims });
  jest.restoreAllMocks();
}

const MONEY = /\d[\d\s  ]*(?:[.,]\d+)?\s?(?:₸|тг|\$|€|₽)/u;
const TIME = /\b\d{1,2}:\d{2}\b/;
const BUTTON_ROLES = new Set(['button', 'radio', 'checkbox', 'togglebutton', 'switch', 'tab', 'link']);

const isEl = (n: JsonNode): n is JsonElement => typeof n !== 'string';
const flat = (style: unknown) => (StyleSheet.flatten(style as ViewStyle) ?? {}) as ViewStyle & TextStyle;

export function textOf(n: JsonNode): string {
  return isEl(n) ? n.children.map(textOf).join('') : n;
}

function hasText(n: JsonElement): boolean {
  if (n.type === 'Text' && textOf(n).trim() !== '') return true;
  return n.children.some((c) => isEl(c) && hasText(c));
}

const hidden = (n: JsonElement) =>
  n.props.accessibilityElementsHidden === true || n.props.importantForAccessibility === 'no-hide-descendants' || n.props['aria-hidden'] === true;

function isButton(n: JsonElement): boolean {
  const role = (n.props.accessibilityRole ?? n.props.role) as string | undefined;
  return !!role && BUTTON_ROLES.has(role) && (typeof n.props.onClick === 'function' || typeof n.props.onResponderRelease === 'function' || n.props.accessible !== false);
}

/** Buttons directly in a row: the row's children, looking through plain wrapper Views. */
function rowButtons(row: JsonElement): JsonElement[] {
  const out: JsonElement[] = [];
  for (const c of row.children) {
    if (!isEl(c)) continue;
    if (isButton(c)) out.push(c);
    else if (c.type === 'View' && c.children.length === 1 && isEl(c.children[0]!) && isButton(c.children[0]!)) out.push(c.children[0]!);
  }
  return out;
}

export function auditLayout(
  root: JsonNode | JsonNode[] | null,
  o: { critical?: string[]; allow?: Allow[]; windowWidth?: number } = {},
): Violation[] {
  const out: Violation[] = [];
  const width = o.windowWidth ?? Dimensions.get('window').width;
  const allowed = (rule: Rule, ids: string[]) => (o.allow ?? []).some((a) => a.rule === rule && ids.some((id) => a.testID.test(id)));
  const push = (rule: Rule, ids: string[], detail: string) => {
    if (!allowed(rule, ids)) out.push({ rule, where: ids[0] ?? '(no testID)', detail: detail.slice(0, 120) });
  };

  const visit = (n: JsonNode, ids: string[], inHidden: boolean, inHorizontal: boolean) => {
    if (!isEl(n)) return;
    const id = typeof n.props.testID === 'string' ? [n.props.testID as string, ...ids] : ids;
    const style = flat(n.props.style);
    const isHidden = inHidden || hidden(n);

    if (n.type === 'Text') {
      const text = textOf(n);
      const lines = n.props.numberOfLines as number | undefined;
      if (lines && lines > 0) {
        // A sum or a time on its own line (not a preview of a person's long note, which opens in full on tap).
        const valueLine = [...text].length <= 40 && (MONEY.test(text) || TIME.test(text));
        const critical = valueLine || (o.critical ?? []).some((c) => c && text.includes(c));
        if (critical) push('clipped-value', id, `numberOfLines=${lines}: ${text}`);
      }
      const mult = n.props.maxFontSizeMultiplier as number | undefined;
      // A sum sized to fit its box by AmountText may be capped lower on purpose: it is shrunk, never cut.
      if (!isHidden && n.props.nativeID !== 'amount-fit' && (n.props.allowFontScaling === false || (mult !== undefined && mult !== 0 && mult < 1.5)))
        push('no-scale', id, `maxFontSizeMultiplier=${mult} allowFontScaling=${n.props.allowFontScaling}: ${text}`);
      return; // nested Text is part of this one
    }

    if (n.type === 'TextInput' && typeof style.height === 'number') push('fixed-input', id, `height ${style.height}`);

    const scroll = n.type === 'RCTScrollView' || n.type === 'ScrollView';
    if (!scroll && !isHidden && hasText(n)) {
      if (typeof style.height === 'number') push('fixed-height', id, `height ${style.height}: ${textOf(n)}`);
      if (typeof style.maxHeight === 'number' && style.overflow !== 'visible') push('fixed-height', id, `maxHeight ${style.maxHeight}: ${textOf(n)}`);
    }
    if (typeof style.width === 'number' && style.width > width) push('too-wide', id, `width ${style.width} > ${width}`);

    if (isButton(n) && !isHidden) {
      if ((typeof style.height === 'number' && style.height < 48) || (typeof style.width === 'number' && style.width < 48 && typeof style.height === 'number'))
        push('small-target', id, `${style.width ?? '-'}×${style.height ?? '-'}: ${textOf(n)}`);
    }

    if (style.flexDirection === 'row' && style.flexWrap !== 'wrap' && !inHorizontal && n.props.accessibilityRole !== 'tablist') {
      const buttons = rowButtons(n).filter((b) => textOf(b).trim().length > 2);
      if (buttons.length >= 3) push('row-of-buttons', id, buttons.map((b) => textOf(b)).join(' | '));
    }

    const horizontal = inHorizontal || (scroll && n.props.horizontal === true);
    for (const c of n.children) visit(c, id, isHidden, horizontal);
  };

  for (const r of Array.isArray(root) ? root : [root]) if (r) visit(r, [], false, false);
  return out;
}
