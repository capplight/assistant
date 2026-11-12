import { useEffect, useState } from 'react';
import { AccessibilityInfo, type ViewStyle } from 'react-native';

import { pressScale } from '@/theme';

/** Whether «Уменьшить движение» is on (follows the system while mounted). */
export function useReducedMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => {
        if (alive) setOn(v);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setOn);
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  return on;
}

/** Press feedback of the system: scale 0.97 (none with reduced motion). The tint is up to the caller. */
export function pressedStyle(pressed: boolean, reduced = false): ViewStyle | null {
  return pressed && !reduced ? { transform: [{ scale: pressScale }] } : null;
}

/** Grow a small visible control to a 48 hit area. */
export function hitSlopFor(visible: number, min = 48) {
  const d = Math.max(0, Math.ceil((min - visible) / 2));
  return { top: d, bottom: d, left: d, right: d };
}
