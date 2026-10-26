import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  // Mirror the tsup `define` so src/version.ts behaves the same under test.
  define: {
    __HOLT_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "node",
    // A HOLT_TOKEN in the developer's shell would otherwise reach every
    // createHolt() under test. Empty counts as unset (config/load.ts).
    env: { HOLT_TOKEN: "" },
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      reporter: ["text", "json-summary", "html"],
    },
  },
});
