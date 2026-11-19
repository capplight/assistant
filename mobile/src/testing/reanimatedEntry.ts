/* eslint-disable @typescript-eslint/no-require-imports */
// Jest only: `react-native-reanimated` itself → the small mock (a separate file from `react-native-reanimated/mock`, so
// expo-router's testing mock, which requires the latter inside its factory for the former, does not loop).
module.exports = require('./reanimatedMock');
