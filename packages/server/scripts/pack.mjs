// Builds the npm tarball that release.yml publishes, with a package.json
// trimmed to what an installer needs. Run after `build`.
//
//   node packages/server/scripts/pack.mjs <destination-dir>
//
// Why not plain `pnpm pack`: its published package.json keeps
// `devDependencies` (with `workspace:*` rewritten to the workspace package's
// version, so `"@holt/protocol": "0.1.0"`, a name that doesn't exist on npm)
// and every script except the publish lifecycle ones. Harmless for installs
// (npm ignores a dependency's devDependencies), but registry pages, audit
// tools and dependency scanners read them, and a reference to an unowned
// scope invites a typo-squatter. pnpm 10 has no switch for this:
// `publishConfig` can only override an allow-list of fields (bin, main,
// exports, types, engines, ...), not delete devDependencies or scripts.
//
// So this script stages the package instead of editing the working
// package.json (an edit-then-restore around `pack` leaves a mangled file
// behind whenever it is interrupted): it copies each entry of `files` into a
// temporary directory next to a trimmed package.json and runs `npm pack`
// there. npm applies the same `files` list and default ignores to the copy
// as to the original, so the contents match what `npm pack` in place
// produces (check-pack.mjs asserts the list). What pnpm pack would have
// added, and why it isn't needed:
//   - `workspace:` rewriting: the only workspace dependency is the bundled
//     @holt/protocol, a devDependency, which is dropped. Any other
//     `workspace:` or `catalog:` specifier fails the script rather than
//     shipping unresolved.
//   - the workspace root LICENSE: the package has its own (copy-license.mjs).
//   - `publishConfig` field overrides: refused below if present, since npm
//     wouldn't apply them.
// `publishConfig.access` and `.provenance` stay in the manifest; npm
// publish reads them from the tarball.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** Top-level fields left out of the published package.json. */
const DEV_ONLY_FIELDS = ["devDependencies", "scripts", "pnpm", "packageManager"];

/** publishConfig keys npm itself reads; anything else is a pnpm override. */
const NPM_PUBLISH_CONFIG = new Set(["access", "provenance", "tag", "registry"]);

/** The package.json that goes into the tarball. Throws on anything it can't publish as-is. */
export function publishManifest(pkg) {
  const out = { ...pkg };
  for (const field of DEV_ONLY_FIELDS) delete out[field];
  const overrides = Object.keys(out.publishConfig ?? {}).filter((key) => !NPM_PUBLISH_CONFIG.has(key));
  if (overrides.length > 0) {
    throw new Error(`publishConfig.${overrides.join(", publishConfig.")}: pnpm-only overrides, which npm pack would ignore`);
  }
  const unresolved = findUnresolvedSpecifiers(out);
  if (unresolved.length > 0) throw new Error(`unresolved specifiers would be published: ${unresolved.join(", ")}`);
  return out;
}

/** Every `workspace:` / `catalog:` value anywhere in `value`, as "path: value". Shared with check-pack. */
export function findUnresolvedSpecifiers(value, at = "") {
  if (typeof value === "string") return /^(?:workspace|catalog):/.test(value) ? [`${at || "(root)"}: ${value}`] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => findUnresolvedSpecifiers(child, at ? `${at}.${key}` : key));
}

/** Packs into `destDir`; returns the tarball's absolute path. */
export function packRelease(destDir) {
  const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const manifest = publishManifest(pkg);
  const stage = mkdtempSync(path.join(tmpdir(), "holt-pack-"));
  try {
    for (const entry of pkg.files) {
      const from = path.join(packageDir, entry);
      // A missing entry is check-pack's to report ("run the build first").
      if (existsSync(from)) cpSync(from, path.join(stage, entry), { recursive: true });
    }
    writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(destDir, { recursive: true });
    const output = execFileSync("npm", ["pack", "--json", "--loglevel=error", "--pack-destination", path.resolve(destDir)], {
      cwd: stage,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const [result] = JSON.parse(output);
    return path.resolve(destDir, result.filename);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2];
  if (!dest) {
    console.error("usage: node scripts/pack.mjs <destination-dir>");
    process.exit(2);
  }
  console.log(packRelease(dest));
}
