/**
 * Config loading: defaults < holt.config.json < overrides.
 *
 * "Overrides" are whatever the host passes programmatically: CLI flags for
 * the standalone server, plugin options for Vite. They win because they are
 * the most specific thing the user typed.
 *
 * Relative paths (outputDir, --config) resolve against the project root
 * (`cwd`), not the config file's folder: the config file normally lives in
 * the root anyway, and one rule is easier to remember than two.
 *
 * The project identity (`config.project`) is resolved here too, once, so
 * every consumer (status route, banners) sees the same answer and nothing
 * re-reads package.json per request. See project.ts for the rules.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE_NAME } from "@holt/protocol";
import { DEFAULTS } from "./defaults.js";
import { readPackageJson, resolveProject } from "./project.js";
import type { HoltConfig, ResolvedConfig } from "./types.js";
import { ConfigError, validateConfig } from "./validate.js";

export interface LoadConfigOptions {
  /**
   * Explicit config file path (e.g. from `--config`). When set, the file
   * must exist. When unset, `<cwd>/holt.config.json` is used if present.
   */
  configFile?: string;
  /** Label for override errors, e.g. "command line flags" or "Vite plugin options". */
  overridesSource?: string;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  /** Non-fatal problems (unknown keys) for the caller to log. */
  warnings: string[];
}

export async function loadConfig(
  cwd: string,
  overrides: HoltConfig = {},
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const root = path.resolve(cwd);
  const warnings: string[] = [];

  const explicit = options.configFile !== undefined;
  const configPath = path.resolve(root, options.configFile ?? CONFIG_FILE_NAME);

  let fromFile: HoltConfig = {};
  let configFile: string | null = null;
  const text = await readOptional(configPath);
  if (text === null) {
    if (explicit) throw new ConfigError(`Config file not found: ${configPath}`);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(`${configPath} is not valid JSON: ${(err as Error).message}`);
    }
    const result = validateConfig(parsed, configPath);
    fromFile = result.config;
    warnings.push(...result.warnings);
    configFile = configPath;
  }

  const fromOverrides = validateConfig(overrides, options.overridesSource ?? "options");
  warnings.push(...fromOverrides.warnings);

  const merged = { ...DEFAULTS, ...fromFile, ...fromOverrides.config };

  const { project, warning } = resolveProject({
    root,
    projectName: merged.projectName,
    // Skip the read entirely when the name is configured.
    packageJson: merged.projectName === undefined ? await readPackageJson(root) : null,
  });
  if (warning !== undefined) warnings.push(warning);

  return {
    config: {
      root,
      outputDir: path.resolve(root, merged.outputDir),
      port: merged.port,
      host: merged.host,
      token: merged.token,
      maxUploadBytes: merged.maxUploadBytes,
      sessionTitle: merged.sessionTitle,
      project,
      allowedOrigins: [...merged.allowedOrigins],
      allowedExtensionIds: [...merged.allowedExtensionIds],
      configFile,
    },
    warnings,
  };
}

/** Read a file, or return null if it does not exist (other errors still throw). */
async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
