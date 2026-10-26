import { defineConfig } from "vitest/config";

// Unit tests cover the pure logic only (geometry, validation, request
// shaping). Anything that needs real Chrome APIs is kept thin and exercised
// by `pnpm smoke` instead, so a plain Node environment is enough here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        // Entry points and glue that are nothing but chrome.*, DOM, canvas or
        // MediaRecorder calls: they cannot run in Node, so their coverage here
        // would always be 0% and only hide the number that matters. They are
        // exercised in real Chrome by `pnpm smoke` and `pnpm e2e` instead
        // (docs/TESTING.md). Logic found in them belongs in a pure module
        // next to them (like indicator-model.ts for indicator.ts), which is
        // then covered here.
        "src/background/{actions,commands,index,indicator,note-popup,notify,offscreen,recording,server-info,voice-overlay}.ts",
        "src/background/capture/{area,full-page,inject,viewport}.ts",
        "src/content/{area-select,page-helper,voice-overlay}.ts",
        "src/menu/**",
        "src/note/**",
        "src/offscreen/**",
        "src/permissions/**",
        "src/shared/{media-recorder,state}.ts",
        "src/sidepanel/{index,store}.ts",
        "src/sidepanel/ui/**",
        "src/welcome/welcome.ts",
      ],
      reporter: ["text", "json-summary", "html"],
    },
  },
  define: {
    __HOLT_VERSION__: JSON.stringify("0.0.0-test"),
  },
});
