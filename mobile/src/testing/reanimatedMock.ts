/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Jest only (`package.json` → `jest.moduleNameMapper`): the part of Reanimated the app uses. The package's own mock
 * imports the real entry point, whose native initializer throws under the native Jest preset.
 * Animations end at once (as with Reduce Motion); styles are computed from the current values on each render.
 */
const React = require('react') as typeof import('react');
const RN = require('react-native') as typeof import('react-native');

type Done = (finished: boolean) => void;

const AnimatedNS = {
  View: RN.View,
  ScrollView: RN.ScrollView,
  Text: RN.Text,
  FlatList: RN.FlatList,
  createAnimatedComponent: <T>(c: T) => c,
  call: () => undefined,
};

const ease = () => (t: number) => t;

module.exports = {
  __esModule: true,
  default: AnimatedNS,
  ...AnimatedNS,
  useSharedValue: <T>(v: T) => React.useState(() => ({ value: v, get: () => v }))[0],
  useAnimatedStyle: (fn: () => object) => fn(),
  useDerivedValue: <T>(fn: () => T) => ({ value: fn() }),
  useAnimatedReaction: () => undefined,
  withTiming: <T>(v: T, _config?: unknown, cb?: Done) => {
    cb?.(true);
    return v;
  },
  withSpring: <T>(v: T, _config?: unknown, cb?: Done) => {
    cb?.(true);
    return v;
  },
  cancelAnimation: () => undefined,
  runOnJS: <T>(fn: T) => fn,
  Easing: { bezier: ease, linear: (t: number) => t, out: ease, in: ease, inOut: ease },
  ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
};
