import { useState } from 'react';
import { PanResponder } from 'react-native';

import { dropIndex, shiftFor } from '@/pages/drag';
import { useView } from '@/store/view';

/**
 * Long press → the card follows the finger, the others move aside, let go → `onDrop(row index)`.
 * Nothing scrolls or moves under the finger meanwhile (the assistant's changes wait, R-54).
 * Not done: scrolling at the screen edges while dragging; a haptic tick on lift.
 */
export function useDrag() {
  const [view, setView] = useState<DragView | null>(null);
  const [ctl] = useState(() => new DragController(setView));
  return {
    handlers: ctl.handlers,
    active: view !== null,
    start: (from: number, onDrop: (to: number) => void) => ctl.start(from, onDrop),
    measure: (index: number, height: number) => ctl.measure(index, height),
    isDragged: (index: number) => view?.from === index,
    shift: (index: number) => {
      if (!view) return 0;
      if (index === view.from) return view.dy;
      return shiftFor(index, view.from, view.to, view.height);
    },
  };
}

type DragView = { from: number; to: number; dy: number; height: number };

/** The finger's part of a drag: row heights, the gesture, the drop. What to draw goes to `show`. */
class DragController {
  private heights: number[] = [];
  private s: { from: number; dy: number; onDrop: (to: number) => void; granted: boolean } | null = null;
  readonly handlers: ReturnType<typeof PanResponder.create>['panHandlers'] & { onTouchEnd: () => void };

  constructor(private readonly show: (v: DragView | null) => void) {
    const pan = PanResponder.create({
      onMoveShouldSetPanResponderCapture: () => this.s !== null,
      onPanResponderGrant: () => {
        if (this.s) this.s.granted = true;
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_e, g) => {
        if (!this.s) return;
        this.s.dy = g.dy;
        this.show(this.view());
      },
      onPanResponderRelease: () => this.end(true),
      onPanResponderTerminate: () => this.end(false),
    });
    // Let go without moving: the long press ends, nothing moves.
    this.handlers = { ...pan.panHandlers, onTouchEnd: () => this.s && !this.s.granted && this.end(false) };
  }

  private view(): DragView | null {
    const s = this.s;
    if (!s) return null;
    return { from: s.from, dy: s.dy, to: dropIndex(this.heights, s.from, s.dy), height: this.heights[s.from] ?? 0 };
  }

  start(from: number, onDrop: (to: number) => void): void {
    this.s = { from, dy: 0, onDrop, granted: false };
    useView.getState().setTouching(true);
    this.show(this.view());
  }

  measure(index: number, height: number): void {
    this.heights[index] = height;
  }

  private end(drop: boolean): void {
    const s = this.s;
    this.s = null;
    this.show(null);
    useView.getState().setTouching(false);
    if (s && drop) s.onDrop(dropIndex(this.heights, s.from, s.dy));
  }
}
