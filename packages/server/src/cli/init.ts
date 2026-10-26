/**
 * `holt init`: write a starter holt.config.json.
 *
 * Every key is written out with its default value, so the file doubles as
 * documentation, and `$schema` points at the schema published with the package
 * for editor autocomplete and hover docs. The exceptions: `projectName`,
 * whose default is derived from package.json; `allowedExtensionIds`, which
 * differs per install; and `token`. This file is meant to be committed, and
 * a `"token": null` placeholder invites filling in a secret right there.
 * Tokens belong in the HOLT_TOKEN environment variable instead (which the
 * CLI's init message points out).
 *
 * Why `$schema` is a CDN URL and not "./node_modules/@velvet-thunder/holt/
 * schema.json": that relative path only resolves when the package is
 * installed in this very directory and hoisted to that spot. Under
 * `npx holt init` with no local install there is no node_modules at all, and
 * in a pnpm workspace the package usually sits in the app's own node_modules,
 * not next to a config file at the workspace root. unpkg serves any file of
 * any published version, so the URL works everywhere an editor has network
 * access. It is pinned to the version that wrote the file, which is the
 * schema matching the keys written here; bumping holt doesn't break it, it
 * just keeps describing the older (still accepted) keys until someone
 * re-runs init or edits the version. The config loader ignores `$schema`
 * (IGNORED_KEYS in config/validate.ts), so any value is accepted.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE_NAME } from "@holt/protocol";
import { DEFAULTS } from "../config/defaults.js";
import { VERSION } from "../version.js";

/** Where editors fetch the config schema from; see the header comment. */
export const SCHEMA_URL = `https://unpkg.com/@velvet-thunder/holt@${VERSION}/schema.json`;

export const STARTER_CONFIG = {
  $schema: SCHEMA_URL,
  outputDir: DEFAULTS.outputDir,
  port: DEFAULTS.port,
  host: DEFAULTS.host,
  maxUploadBytes: DEFAULTS.maxUploadBytes,
  sessionTitle: DEFAULTS.sessionTitle,
  allowedOrigins: [],
};

/** Returns the path written. Throws if the file exists and `force` is false. */
export async function writeStarterConfig(cwd: string, force: boolean): Promise<string> {
  const file = path.join(cwd, CONFIG_FILE_NAME);
  try {
    // "wx" fails if the file exists, without a separate (racy) exists check.
    await writeFile(file, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, { flag: force ? "w" : "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${file} already exists. Use \`holt init --force\` to overwrite it.`);
    }
    throw err;
  }
  return file;
}
