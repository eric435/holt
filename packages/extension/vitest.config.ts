import { defineConfig } from "vitest/config";

// Unit tests cover the pure logic only (geometry, validation, request
// shaping). Anything that needs real Chrome APIs is kept thin and exercised
// by `pnpm smoke` instead, so a plain Node environment is enough here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  define: {
    __NITPICK_VERSION__: JSON.stringify("0.0.0-test"),
  },
});
