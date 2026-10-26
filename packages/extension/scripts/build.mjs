#!/usr/bin/env node
/**
 * Build the extension into dist/ with plain esbuild. No framework, so every
 * moving part is visible here:
 *
 *   src/background/index.ts      -> dist/background.js           (ESM: manifest says "type": "module")
 *   src/sidepanel/index.ts       -> dist/sidepanel.js            (ESM: <script type="module">)
 *   src/permissions/permissions.ts -> dist/permissions.js        (ESM)
 *   src/offscreen/index.ts       -> dist/offscreen.js            (ESM: the recorders' hidden page)
 *   src/note/note.ts             -> dist/note.js                 (ESM: the Alt+T note popup)
 *   src/menu/menu.ts             -> dist/menu.js                 (ESM: the toolbar menu, action popup)
 *   src/welcome/welcome.ts       -> dist/welcome.js              (ESM: the first-install welcome tab)
 *   src/content/area-select.ts   -> dist/content/area-select.js  (IIFE: injected with
 *   src/content/page-helper.ts   -> dist/content/page-helper.js   executeScript({ files }),
 *   src/content/voice-overlay.ts -> dist/content/voice-overlay.js which runs classic scripts only)
 *   manifest.json (version from package.json), HTML, CSS, public/icons -> dist/
 *
 * `@holt/protocol` is TypeScript source in the workspace; esbuild follows
 * the import and bundles it like our own code.
 *
 * Usage: node scripts/build.mjs [--watch]
 */

import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

/** Options shared by both bundles. */
const common = {
  bundle: true,
  // Readable output: this is loaded unpacked for local use, not shipped minified.
  minify: false,
  sourcemap: "linked",
  target: "chrome127", // keep in sync with manifest.json minimum_chrome_version
  platform: "browser",
  logLevel: "info",
  define: { __HOLT_VERSION__: JSON.stringify(pkg.version) },
  absWorkingDir: root,
};

/** Static files copied verbatim (source -> path inside dist). */
const STATIC_FILES = [
  ["src/sidepanel/sidepanel.html", "sidepanel.html"],
  ["src/sidepanel/sidepanel.css", "sidepanel.css"],
  ["src/permissions/permissions.html", "permissions.html"],
  ["src/offscreen/offscreen.html", "offscreen.html"],
  ["src/note/note.html", "note.html"],
  ["src/menu/menu.html", "menu.html"],
  ["src/welcome/welcome.html", "welcome.html"],
];

async function copyStatic() {
  for (const [from, to] of STATIC_FILES) {
    await mkdir(dirname(join(dist, to)), { recursive: true });
    await cp(join(root, from), join(dist, to));
  }
  await cp(join(root, "public/icons"), join(dist, "icons"), { recursive: true });

  // The manifest's version comes from package.json, so there is one source of truth.
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  manifest.version = pkg.version;
  await writeFile(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/** esbuild plugin: re-copy static files after every (re)build. */
const copyStaticPlugin = {
  name: "copy-static",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length === 0) await copyStatic();
    });
  },
};

const moduleBuild = {
  ...common,
  format: "esm",
  entryPoints: {
    background: "src/background/index.ts",
    sidepanel: "src/sidepanel/index.ts",
    permissions: "src/permissions/permissions.ts",
    offscreen: "src/offscreen/index.ts",
    note: "src/note/note.ts",
    menu: "src/menu/menu.ts",
    welcome: "src/welcome/welcome.ts",
  },
  outdir: dist,
  plugins: [copyStaticPlugin],
};

const contentBuild = {
  ...common,
  format: "iife",
  entryPoints: {
    "content/area-select": "src/content/area-select.ts",
    "content/page-helper": "src/content/page-helper.ts",
    "content/voice-overlay": "src/content/voice-overlay.ts",
  },
  outdir: dist,
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

if (watch) {
  const contexts = await Promise.all([esbuild.context(moduleBuild), esbuild.context(contentBuild)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  // esbuild only watches files it bundles; watch the static ones ourselves.
  for (const file of [...STATIC_FILES.map(([from]) => from), "manifest.json", "public/icons"]) {
    fsWatch(join(root, file), { recursive: true }, () => copyStatic().catch((e) => console.error(e)));
  }
  console.log("[holt] watching. After changes, click the reload icon on chrome://extensions (the side panel reloads with it).");
} else {
  await Promise.all([esbuild.build(moduleBuild), esbuild.build(contentBuild)]);
  console.log(`[holt] built ${pkg.name}@${pkg.version} into ${dist}`);
}
