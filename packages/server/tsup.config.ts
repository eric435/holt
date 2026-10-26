/**
 * Build config for the published package.
 *
 * Three entry points, all ESM:
 *   dist/index.js  programmatic API  (`import { createHolt } from "@velvet-thunder/holt"`)
 *   dist/vite.js   Vite plugin       (`import holt from "@velvet-thunder/holt/vite"`)
 *   dist/cli.js    the `holt` bin (tsup keeps the source's `#!` line and chmods it)
 *
 * `@holt/protocol` is a private workspace package consumed as TypeScript
 * source, so it is bundled in (it is a devDependency, which tsup does not
 * externalize) and its types are inlined into the .d.ts files. The published
 * package therefore has no reference to it at all.
 */
import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    vite: "src/adapters/vite.ts",
    cli: "src/cli/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  // Shared code between the entries goes into chunks instead of being
  // duplicated, so `@velvet-thunder/holt` and `@velvet-thunder/holt/vite` share one copy.
  splitting: true,
  clean: true,
  // Types only for the importable entries; the CLI is not imported by anyone.
  dts: {
    entry: { index: "src/index.ts", vite: "src/adapters/vite.ts" },
    // Point the declaration bundler straight at the protocol source. Through
    // node_modules it would be treated as an external library and left as an
    // `import ... from "@holt/protocol"`, which users could not resolve.
    compilerOptions: {
      paths: { "@holt/protocol": ["../shared/src/index.ts"] },
    },
  },
  noExternal: ["@holt/protocol"],
  // Keep `node:` prefixes in the output: it makes built-in imports unmistakable.
  removeNodeProtocol: false,
  // The package version is baked in at build time (see src/version.ts for why).
  define: {
    __HOLT_VERSION__: JSON.stringify(pkg.version),
  },
});
