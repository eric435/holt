/**
 * Hand-written config validation.
 *
 * Why not a schema library (zod, ajv, ...)? This package is installed into
 * other people's projects, and every runtime dependency is supply-chain
 * surface for them (see docs/SECURITY.md). The config has seven keys; a few
 * `typeof` checks are easier to audit than a dependency tree.
 *
 * Rules:
 *  - Every error names the key, the expected type, and what was found, and
 *    all errors are reported at once (fix-all-then-rerun beats whack-a-mole).
 *  - Unknown keys are a warning, not an error: a typo should not stop your
 *    dev server, but it should not pass silently either.
 *  - The result only contains keys that were actually set, so callers can
 *    merge layers (defaults < file < overrides) with a plain object spread.
 */
import type { NitpickConfig } from "./types.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface ValidationResult {
  config: NitpickConfig;
  warnings: string[];
}

/** Each validator returns an error message (without the key) or null if OK. */
type Check = (value: unknown) => string | null;

const isString = (v: unknown): v is string => typeof v === "string";

const nonEmptyString: Check = (v) =>
  isString(v) && v.trim() !== "" ? null : `must be a non-empty string (got ${describe(v)})`;

const portNumber: Check = (v) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 65535
    ? null
    : `must be an integer from 0 to 65535 (got ${describe(v)})`;

const positiveInteger: Check = (v) =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0
    ? null
    : `must be a positive integer number of bytes (got ${describe(v)})`;

const tokenValue: Check = (v) =>
  v === null || (isString(v) && v !== "")
    ? null
    : `must be a non-empty string or null (got ${describe(v)})`;

const originList: Check = (v) => {
  if (!Array.isArray(v)) return `must be an array of origin strings (got ${describe(v)})`;
  for (const item of v) {
    const problem = checkOrigin(item);
    if (problem) return problem;
  }
  return null;
};

/**
 * An allowed origin must be exactly `scheme://host[:port]`. We refuse "*" and
 * anything with a path because "allow every origin" is the one setting that
 * would turn the server into something any web page can write through.
 */
function checkOrigin(item: unknown): string | null {
  if (!isString(item)) return `must contain only strings (got ${describe(item)})`;
  if (item.includes("*")) {
    return `must not contain wildcards (got ${JSON.stringify(item)}); list each origin explicitly`;
  }
  let url: URL;
  try {
    url = new URL(item);
  } catch {
    return `must contain origins like "http://localhost:3000" (got ${JSON.stringify(item)})`;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== item) {
    return (
      `must contain exact http(s) origins with no path or trailing slash, like ` +
      `"http://localhost:3000" (got ${JSON.stringify(item)}). ` +
      `chrome-extension:// origins are always allowed and need not be listed.`
    );
  }
  return null;
}

const CHECKS: Record<keyof NitpickConfig, Check> = {
  outputDir: nonEmptyString,
  port: portNumber,
  host: nonEmptyString,
  token: tokenValue,
  maxUploadBytes: positiveInteger,
  sessionTitle: nonEmptyString,
  allowedOrigins: originList,
};

/** Keys that may appear in the file but are not config (editor hints). */
const IGNORED_KEYS = new Set(["$schema"]);

/**
 * Validate an untrusted value (parsed JSON, plugin options, CLI flags).
 * `source` names where it came from, for error messages.
 * Throws ConfigError listing every problem; returns warnings otherwise.
 */
export function validateConfig(raw: unknown, source: string): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${source}: expected a JSON object (got ${describe(raw)})`);
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const config: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (IGNORED_KEYS.has(key)) continue;
    // `undefined` means "not set"; it lets callers pass `{ port: flags.port }`
    // without checking first. (It cannot occur in JSON.)
    if (value === undefined) continue;

    if (!Object.hasOwn(CHECKS, key)) {
      warnings.push(
        `${source}: unknown key "${key}" is ignored. Known keys: ${Object.keys(CHECKS).join(", ")}.`,
      );
      continue;
    }
    const problem = CHECKS[key as keyof NitpickConfig](value);
    if (problem) errors.push(`"${key}" ${problem}`);
    else config[key] = value;
  }

  if (errors.length > 0) {
    const list = errors.map((e) => `  - ${e}`).join("\n");
    throw new ConfigError(`Invalid config in ${source}:\n${list}`);
  }
  return { config: config as NitpickConfig, warnings };
}

/** Short, human description of a value for error messages. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : `number ${value}`;
  return typeof value;
}
