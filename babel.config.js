/**
 * Babel configuration used exclusively by the Jest component test project
 * (src/components/__tests__). The ts-jest project for db/services tests
 * ignores this file via its own transform configuration.
 *
 * babel-preset-expo ships React JSX runtime, TypeScript stripping, and the
 * react-native platform alias transforms required by RNTL.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
