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
  useSharedValue: <T>(v: T) =>
    React.useState(() => {
      const sv = {
        value: v,
        get: () => sv.value,
        set: (x: T | ((prev: T) => T)) => {
          sv.value = typeof x === 'function' ? (x as (prev: T) => T)(sv.value) : x;
        },
      };
      return sv;
    })[0],
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
  // What Gesture Handler asks of Reanimated (Ф-89 calendar gestures); no native events fire under Jest.
  useEvent: () => () => undefined,
  useHandler: () => ({ doDependenciesDiffer: false, context: {} }),
  useComposedEventHandler: () => () => undefined,
  isSharedValue: (v: unknown) => !!v && typeof v === 'object' && 'value' in (v as object) && typeof (v as { get?: unknown }).get === 'function',
  setGestureState: () => undefined,
  runOnJS: <T>(fn: T) => fn,
  Easing: { bezier: ease, linear: (t: number) => t, out: ease, in: ease, inOut: ease },
  ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
};
