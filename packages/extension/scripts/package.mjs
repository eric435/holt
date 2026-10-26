#!/usr/bin/env node
/**
 * Zip dist/ into the file you upload to the Chrome Web Store:
 *
 *   release/holt-extension-<version>.zip
 *
 * Run it through `pnpm --filter @holt/extension package` (or `pnpm
 * package:extension` from the repo root), which builds first, so the zip is
 * always the output of build.mjs + check-manifest.mjs.
 *
 * What goes in: every file in dist/ except source maps (*.map, ~1 MB that
 * only helps us debug) and dotfiles (a stray .DS_Store copied in with
 * public/icons). Anything with an extension outside ALLOWED_EXTENSIONS
 * fails the run instead of shipping quietly, the same idea as the server's
 * check-pack.mjs. Because the maps stay behind, the trailing
 * `//# sourceMappingURL=<file>.js.map` comment that esbuild's `sourcemap:
 * "linked"` puts in each JS file is removed from the zipped copy: it would
 * point at a file that isn't there, and DevTools would log a failed
 * source-map fetch for every script whenever someone inspects the
 * extension. Only that last line is touched; the code is byte-for-byte what
 * the build wrote and the smoke test loaded.
 *
 * Refuses to write a zip when:
 *  - the dist manifest version is "0.0.0" (or doesn't match package.json,
 *    i.e. dist/ is stale);
 *  - the git tag `extension-v<version>` already exists locally, meaning that
 *    version was already released. The Web Store rejects an upload whose
 *    version isn't higher than the published one, so bump `version` in
 *    package.json instead. Run `git fetch --tags` first to see tags made by
 *    the Extension release workflow. Outside a git checkout the check is
 *    skipped with a warning.
 *
 * The zip is written by hand with zero dependencies (node:zlib's
 * deflateRawSync + a CRC32): local file header + data per entry, then the
 * central directory and its end record. It is reproducible: entries are
 * sorted, every timestamp is the DOS epoch (1980-01-01 00:00), modes are a
 * fixed 0644, and there are no extra fields. Two runs on the same dist/ and
 * Node version give identical bytes (the SHA-256 is printed to compare).
 * There are no directory entries; unzip and Chrome create directories from
 * the file paths.
 *
 * Usage: node scripts/package.mjs   (after a build)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const outDir = join(root, "release");
const ALLOWED_EXTENSIONS = [".js", ".html", ".css", ".png", ".json"];

const fail = (message) => {
  console.error(`[holt] package FAILED: ${message}`);
  process.exit(1);
};

// ---- guards ------------------------------------------------------------------

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
let manifest;
try {
  manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
} catch {
  fail("dist/manifest.json missing: run `pnpm --filter @holt/extension build` first.");
}
const version = manifest.version;
if (!version || version === "0.0.0") fail(`dist manifest version is ${JSON.stringify(version)}; set a real version in package.json.`);
if (version !== pkg.version) fail(`dist manifest version ${version} != package.json ${pkg.version}; dist/ is stale, rebuild.`);

const tag = `extension-v${version}`;
let tagged = false;
try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" });
  try {
    execFileSync("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`], { cwd: root, stdio: "ignore" });
    tagged = true;
  } catch {
    // rev-parse --verify exits non-zero when the tag doesn't exist: good.
  }
} catch {
  console.warn(`[holt] warning: not a git checkout, can't check whether ${tag} was already released.`);
}
if (tagged) fail(`tag ${tag} already exists: ${version} was already released. Bump "version" in packages/extension/package.json.`);

// ---- collect files -----------------------------------------------------------

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const SOURCE_MAP_COMMENT = /\n\/\/# sourceMappingURL=[^\n]+\.map\n?$/;

const entries = [];
for (const path of await walk(dist)) {
  const name = relative(dist, path).split(sep).join("/");
  const base = name.split("/").pop();
  if (name.endsWith(".map") || base.startsWith(".")) continue;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) fail(`unexpected file in dist/: ${name} (allowed: ${ALLOWED_EXTENSIONS.join(" ")})`);
  let data = await readFile(path);
  if (ext === ".js") data = Buffer.from(data.toString("utf8").replace(SOURCE_MAP_COMMENT, "\n"), "utf8");
  entries.push({ name, data });
}
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
if (!entries.some((e) => e.name === "manifest.json")) fail("manifest.json is not at the root of dist/");

// ---- zip encoding ------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01 (years since 1980, month, day)
const VERSION_NEEDED = 20; // 2.0: deflate
const VERSION_MADE_BY = (3 << 8) | 20; // 3 = Unix, so the external attributes below are a Unix mode
const UNIX_MODE = 0o100644; // regular file, rw-r--r--

const locals = [];
const centrals = [];
let offset = 0;
for (const { name, data } of entries) {
  const nameBytes = Buffer.from(name, "ascii");
  const deflated = deflateRawSync(data, { level: 9 });
  // PNGs are already compressed; store them when deflate doesn't help.
  const method = deflated.length < data.length ? 8 : 0;
  const body = method === 8 ? deflated : data;
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(VERSION_NEEDED, 4);
  local.writeUInt16LE(0, 6); // flags: none (sizes known up front, ASCII names)
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28); // extra field length
  locals.push(local, nameBytes, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header signature
  central.writeUInt16LE(VERSION_MADE_BY, 4);
  central.writeUInt16LE(VERSION_NEEDED, 6);
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30); // extra field length
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34); // disk number
  central.writeUInt16LE(0, 36); // internal attributes
  central.writeUInt32LE((UNIX_MODE << 16) >>> 0, 38); // external attributes
  central.writeUInt32LE(offset, 42); // offset of the local header
  centrals.push(central, nameBytes);

  offset += local.length + nameBytes.length + body.length;
}

const centralDir = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
end.writeUInt16LE(0, 4); // this disk
end.writeUInt16LE(0, 6); // disk with the central directory
end.writeUInt16LE(entries.length, 8); // entries on this disk
end.writeUInt16LE(entries.length, 10); // entries in total
end.writeUInt32LE(centralDir.length, 12);
end.writeUInt32LE(offset, 16); // central directory offset
end.writeUInt16LE(0, 20); // comment length
// No zip64: a Web Store package is far below the 4 GB / 65535-entry limits.

const zip = Buffer.concat([...locals, centralDir, end]);
await mkdir(outDir, { recursive: true });
const file = join(outDir, `holt-extension-${version}.zip`);
await writeFile(file, zip);
const sha256 = createHash("sha256").update(zip).digest("hex");
console.log(`[holt] wrote ${relative(process.cwd(), file) || file}`);
console.log(`[holt]   ${entries.length} files, ${(zip.length / 1024).toFixed(1)} KiB, sha256 ${sha256}`);
console.log(`[holt]   upload it at https://chrome.google.com/webstore/devconsole, then tag the release: ${tag}`);
