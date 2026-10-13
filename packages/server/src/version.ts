/**
 * The package version, reported by `GET /status` and `nitpick --version`.
 *
 * Why a build-time constant instead of reading package.json at runtime:
 * after bundling, the code lives in dist/*.js chunks whose location relative
 * to package.json depends on how tsup splits them, so `createRequire(...)
 * ("../package.json")` would be fragile. tsup's `define` replaces
 * `__NITPICK_VERSION__` with a string literal, so there is no file I/O and
 * nothing to get wrong. The fallback only matters if someone runs the source
 * without going through tsup or vitest.
 */
export const VERSION: string =
  typeof __NITPICK_VERSION__ === "string" ? __NITPICK_VERSION__ : "0.0.0-dev";
