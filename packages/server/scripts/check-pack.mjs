// Fails if the npm tarball would contain anything unexpected, or lack
// something it needs, or if its package.json carries anything dev-only.
// It builds the real tarball with pack.mjs (the same script release.yml
// publishes from) into a temporary directory and reads the tarball itself,
// so what is checked is byte-for-byte what would be published. Run after
// `build`.
//
//   pnpm --filter @velvet-thunder/holt check-pack
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { findUnresolvedSpecifiers, packRelease } from "./pack.mjs";

/** Every published file must match one of these. */
const ALLOWED = [/^dist\/.+/, /^schema\.json$/, /^README\.md$/, /^LICENSE$/, /^package\.json$/];

/** And these must be present. */
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "schema.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/vite.js",
  "dist/vite.d.ts",
  "dist/cli.js",
];

/**
 * The regular files in a .tgz, as { "relative/path": Buffer }, without the
 * "package/" prefix npm puts on every entry. A minimal ustar reader (512-byte
 * header, then the content padded to 512) so the check needs no `tar` binary
 * and no dependency; it understands the pax "path" record npm writes for
 * names over 100 bytes and skips everything that isn't a regular file.
 */
function readTarball(file) {
  const tar = gunzipSync(readFileSync(file));
  const entries = {};
  let paxPath;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
      continue;
    }
    const prefix = field(345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    paxPath = undefined;
    if (type === "0") entries[name.replace(/^package\//, "")] = body;
  }
  return entries;
}

const scratch = mkdtempSync(path.join(tmpdir(), "holt-check-pack-"));
const problems = [];
let files = [];
let pkg = {};
try {
  const entries = readTarball(packRelease(scratch));
  files = Object.keys(entries).sort();
  pkg = JSON.parse(entries["package.json"]?.toString("utf8") ?? "{}");
} catch (err) {
  problems.push(err.message);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

for (const file of files) {
  if (!ALLOWED.some((pattern) => pattern.test(file))) problems.push(`unexpected file in package: ${file}`);
}
for (const file of REQUIRED) {
  if (files.length > 0 && !files.includes(file)) {
    problems.push(`missing from package: ${file}${file.startsWith("dist/") || file === "LICENSE" ? " (run the build first)" : ""}`);
  }
}

// The package promises zero runtime dependencies (docs/SECURITY.md).
for (const field of ["dependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) {
  const deps = pkg[field];
  if (deps && (Array.isArray(deps) ? deps.length : Object.keys(deps).length) > 0) {
    problems.push(`package.json "${field}" must be empty (zero runtime dependencies)`);
  }
}
// What pack.mjs strips. Checked on the tarball, so a change to pack.mjs
// (or a release that bypassed it) can't quietly bring them back. No
// `scripts` also means no install-time scripts, ever.
for (const field of ["devDependencies", "scripts"]) {
  if (field in pkg) problems.push(`packed package.json has "${field}" (dev-only; pack.mjs should drop it)`);
}
for (const spec of findUnresolvedSpecifiers(pkg)) problems.push(`packed package.json has an unresolved specifier: ${spec}`);

const id = `${pkg.name ?? "@velvet-thunder/holt"}@${pkg.version ?? "?"}`;
if (problems.length > 0) {
  console.error(`check-pack: ${id} failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`check-pack: ${id} OK, ${files.length} files:\n${files.map((f) => `  ${f}`).join("\n")}`);
