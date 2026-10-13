/**
 * `nitpick init`: write a starter nitpick.config.json.
 *
 * Every key is written out with its default value, so the file doubles as
 * documentation, and `$schema` points at the schema shipped in the package
 * for editor autocomplete and hover docs.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE_NAME } from "@nitpick/protocol";
import { DEFAULTS } from "../config/defaults.js";

export const STARTER_CONFIG = {
  $schema: "./node_modules/nitpick-notes/schema.json",
  outputDir: DEFAULTS.outputDir,
  port: DEFAULTS.port,
  host: DEFAULTS.host,
  token: DEFAULTS.token,
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
      throw new Error(`${file} already exists. Use \`nitpick init --force\` to overwrite it.`);
    }
    throw err;
  }
  return file;
}
