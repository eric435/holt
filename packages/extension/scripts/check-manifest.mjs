#!/usr/bin/env node
/**
 * Sanity-check dist/ after a build:
 *  - every file the manifest references exists;
 *  - files referenced from the HTML pages exist;
 *  - the on-demand content scripts (injected via executeScript, so NOT in
 *    the manifest) were emitted, and are classic scripts (no import/export);
 *  - permissions are exactly the minimal set we intend to ship;
 *  - at most 4 commands have suggested keys (Chrome 155 refuses to load an
 *    extension with more: "Too many shortcuts specified for 'commands': The
 *    maximum is 4."), no two share a key, and every command the code
 *    handles exists;
 *  - esbuild's target matches minimum_chrome_version.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist");
const problems = [];
const check = (condition, message) => condition || problems.push(message);
const exists = (rel) => existsSync(join(dist, rel));

if (!exists("manifest.json")) {
  console.error("dist/manifest.json missing: run the build first.");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));

// 1. Files referenced by the manifest.
const referenced = new Set([
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
]);
for (const file of referenced) {
  check(typeof file === "string", `manifest references a non-string path: ${file}`);
  if (typeof file === "string") check(exists(file), `manifest references missing file: ${file}`);
}
check(manifest.manifest_version === 3, "manifest_version must be 3");
check(manifest.background?.type === "module", "background.type must be 'module' (background.js is ESM)");
check(/^\d+(\.\d+){0,3}$/.test(manifest.version), `invalid version: ${manifest.version}`);

// 2. Files referenced from HTML pages (script src / link href / img src).
for (const page of ["sidepanel.html", "permissions.html", "offscreen.html", "note.html"]) {
  check(exists(page), `missing ${page}`);
  if (!exists(page)) continue;
  const html = readFileSync(join(dist, page), "utf8").replace(/<!--[\s\S]*?-->/g, ""); // ignore comments
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    check(exists(ref), `${page} references missing file: ${ref}`);
  }
  check(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), `${page} has an inline <script>, which MV3's CSP blocks`);
}

// 3. Injected content scripts.
for (const file of ["content/area-select.js", "content/page-helper.js"]) {
  check(exists(file), `content script not emitted: ${file}`);
  if (!exists(file)) continue;
  const code = readFileSync(join(dist, file), "utf8");
  check(!/^\s*(import|export)\s/m.test(code), `${file} must be a classic script (found import/export)`);
}

// 4. Permissions.
// offscreen: the recorders' hidden page; tabCapture: "Record tab" (see README).
const EXPECTED_PERMISSIONS = ["activeTab", "offscreen", "scripting", "sidePanel", "storage", "tabCapture"];
const EXPECTED_HOSTS = ["http://127.0.0.1/*", "http://localhost/*"];
const same = (a = [], b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
check(same(manifest.permissions, EXPECTED_PERMISSIONS), `unexpected permissions: ${JSON.stringify(manifest.permissions)}`);
check(same(manifest.host_permissions, EXPECTED_HOSTS), `unexpected host_permissions: ${JSON.stringify(manifest.host_permissions)}`);
check(!manifest.content_scripts, "content scripts are injected on demand; none should be declared");

// 5. Commands.
const commands = manifest.commands ?? {};
const withKeys = Object.entries(commands).filter(([, c]) => c.suggested_key);
check(withKeys.length <= 4, `Chrome allows at most 4 commands with suggested keys, found ${withKeys.length}: ${withKeys.map(([n]) => n).join(", ")}`);
const keys = withKeys.flatMap(([, c]) => Object.values(c.suggested_key));
check(new Set(withKeys.map(([, c]) => c.suggested_key.default)).size === withKeys.length, `two commands suggest the same key: ${keys.join(", ")}`);
for (const name of ["open-panel", "screenshot-viewport", "screenshot-full", "screenshot-area", "toggle-recording", "toggle-voice", "quick-note"]) {
  check(commands[name], `command missing from the manifest: ${name}`);
}

// 6. Build target vs minimum Chrome version (build.mjs: target "chromeNNN").
const buildScript = readFileSync(join(dist, "..", "scripts", "build.mjs"), "utf8");
const target = buildScript.match(/target:\s*"chrome(\d+)"/)?.[1];
check(target === manifest.minimum_chrome_version, `esbuild target chrome${target} != minimum_chrome_version ${manifest.minimum_chrome_version}`);

if (problems.length) {
  console.error("Manifest check FAILED:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log(`[holt] manifest check OK (${referenced.size} manifest files, content scripts present, permissions minimal)`);
