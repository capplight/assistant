import { createContext } from 'react';
import { create } from 'zustand';

import type { PlaceKey } from '@/theme/colors';

/** True inside the main tabs: screens end their paper above the floating tab bar (`useChrome().tabBarHeight`). */
export const InTabsContext = createContext(false);

/**
 * The v5 chrome around screens (not persisted): how tall the floating bottom is (tab bar + safe area) so a
 * `PlaceScreen` ends its paper above it, and the scroll state the assistant strip (Ф-82, variant C) reacts to.
 */
type State = {
  /** Height of the tab bar incl. the bottom safe area; 0 while it is hidden (keyboard, «Я в магазине»). */
  tabBarHeight: number;
  /** Whether the assistant strip is shown over the current screen. */
  askShown: boolean;
  /** Collapsed into the circle (`useAskCollapse` decides). */
  askCollapsed: boolean;
  /** The strip must stay open: focused, typing, voice, a notice or an answer on screen. */
  askPinned: boolean;
  /** The strip's hint set by the open place itself («Записать в Транспорт…», «Спросите про этот чек…»). */
  askHint: string | null;
  setAskHint: (h: string | null) => void;
  /** A tap on the «Сегодня» tab while it is open (Ф-85: the day view goes back to today). */
  todayTap: number;
  tapToday: () => void;
  /** The place of the screen on top: bottom sheets carry its 6 dp strip. */
  place: PlaceKey;
  setPlace: (p: PlaceKey) => void;
  setTabBarHeight: (h: number) => void;
  setAskShown: (v: boolean) => void;
  setAskCollapsed: (v: boolean) => void;
  setAskPinned: (v: boolean) => void;
};

export const useChrome = create<State>()((set) => ({
  tabBarHeight: 0,
  askShown: false,
  askCollapsed: false,
  askPinned: false,
  place: 'stone',
  askHint: null,
  todayTap: 0,
  tapToday: () => set((s) => ({ todayTap: s.todayTap + 1 })),
  setAskHint: (askHint) => set((s) => (s.askHint === askHint ? s : { askHint })),
  setPlace: (place) => set((s) => (s.place === place ? s : { place })),
  setTabBarHeight: (tabBarHeight) => set((s) => (s.tabBarHeight === tabBarHeight ? s : { tabBarHeight })),
  setAskShown: (askShown) => set((s) => (s.askShown === askShown ? s : { askShown, askCollapsed: false })),
  setAskCollapsed: (askCollapsed) => set((s) => (s.askCollapsed === askCollapsed || (askCollapsed && s.askPinned) ? s : { askCollapsed })),
  setAskPinned: (askPinned) => set((s) => (s.askPinned === askPinned ? s : { askPinned, askCollapsed: askPinned ? false : s.askCollapsed })),
}));

/**
 * Ф-82 «когда свернуть / раскрыть», pure: fed with every scroll sample, returns the next state.
 * Collapse after > 24 dp of continuous downward scroll (and not at the very top); expand at once on > 24 dp up and
 * when ≤ 24 dp from the end. The 600 ms idle expand is a timer outside (`useAskCollapse`).
 */
export type AskScrollState = { collapsed: boolean; lastY: number; runStart: number; dir: 0 | 1 | -1 };
export const ASK_SCROLL_START: AskScrollState = { collapsed: false, lastY: 0, runStart: 0, dir: 0 };

export function askScrollStep(
  prev: AskScrollState,
  s: { y: number; contentHeight: number; viewportHeight: number; pinned: boolean },
  rules = { down: 24, up: 24, nearEnd: 24, top: 24 },
): AskScrollState {
  const step = s.y - prev.lastY;
  const moved: 0 | 1 | -1 = step > 0 ? 1 : step < 0 ? -1 : 0;
  const turned = moved !== 0 && moved !== prev.dir;
  const dir = moved === 0 ? prev.dir : moved;
  const runStart = turned ? prev.lastY : prev.runStart;
  const run = s.y - runStart;
  const base = { lastY: s.y, runStart, dir };
  const fits = s.contentHeight <= s.viewportHeight + 1;
  const nearEnd = s.contentHeight - (s.y + s.viewportHeight) <= rules.nearEnd;
  if (s.pinned || fits || nearEnd) return { ...base, collapsed: false };
  if (dir === 1 && run > rules.down && s.y > rules.top) return { ...base, collapsed: true };
  if (dir === -1 && -run > rules.up) return { ...base, collapsed: false };
  return { ...base, collapsed: prev.collapsed };
}

let askScroll: AskScrollState = ASK_SCROLL_START;
let idle: ReturnType<typeof setTimeout> | null = null;

/** Every scroll sample of the screen under the strip (PlaceScreen calls it); expands again 600 ms after it stops. */
export function feedAskScroll(y: number, contentHeight: number, viewportHeight: number, idleMs = 600): void {
  const chrome = useChrome.getState();
  askScroll = askScrollStep(askScroll, { y, contentHeight, viewportHeight, pinned: chrome.askPinned });
  chrome.setAskCollapsed(askScroll.collapsed);
  if (idle) clearTimeout(idle);
  idle = null;
  if (askScroll.collapsed) {
    idle = setTimeout(() => {
      idle = null;
      askScroll = { ...askScroll, collapsed: false };
      useChrome.getState().setAskCollapsed(false);
    }, idleMs);
  }
}

/** A new tab / screen opens with the strip expanded. */
export function resetAskScroll(): void {
  if (idle) clearTimeout(idle);
  idle = null;
  askScroll = ASK_SCROLL_START;
  useChrome.getState().setAskCollapsed(false);
}
