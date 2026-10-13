/**
 * Command-line parsing for the `holt` bin, using node:util's parseArgs
 * (no argument-parsing dependency). Pure: argv in, a command out, so it can
 * be tested without spawning processes.
 */
import { parseArgs } from "node:util";
import { DEFAULT_PORT } from "@holt/protocol";
import type { HoltConfig } from "../config/types.js";

export type CliCommand =
  | { command: "serve"; overrides: HoltConfig; configFile?: string }
  | { command: "init"; force: boolean }
  | { command: "help" }
  | { command: "version" };

/** Bad flags or arguments: print the message plus a pointer to --help. */
export class CliUsageError extends Error {
  override name = "CliUsageError";
}

export const HELP_TEXT = `holt: write screenshots, recordings and QA notes into your repo

Usage:
  holt [options]        start the local server for the holt extension
  holt init [--force]   create a starter holt.config.json here

Options:
  --port <n>       port to listen on (default ${DEFAULT_PORT})
  --host <host>    interface to bind (default 127.0.0.1; keep it on loopback)
  --out <dir>      where session folders are written (default "qa")
  --project-name <name>
                   name the extension shows for this project (default: the
                   "name" in ./package.json, else the directory name)
  --config <file>  config file to use (default ./holt.config.json if present)
  --token <secret> require this token from the extension. Prefer the config
                   file: command-line arguments are visible to other local
                   processes and end up in shell history.
  -h, --help       show this help
  -v, --version    print the version

Flags override holt.config.json, which overrides the defaults.
Docs: https://www.npmjs.com/package/holt`;

export function parseCliArgs(argv: string[]): CliCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        out: { type: "string" },
        "project-name": { type: "string" },
        config: { type: "string" },
        token: { type: "string" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    // parseArgs throws TypeErrors with messages like "Unknown option '--prot'".
    throw new CliUsageError((err as Error).message);
  }
  const { values, positionals } = parsed;

  if (values.help) return { command: "help" };
  if (values.version) return { command: "version" };

  const [subcommand, ...rest] = positionals;
  if (rest.length > 0) throw new CliUsageError(`Unexpected argument: ${rest.join(" ")}`);

  if (subcommand === "init") return { command: "init", force: values.force ?? false };
  if (subcommand !== undefined) throw new CliUsageError(`Unknown command: ${subcommand}`);
  if (values.force) throw new CliUsageError("--force only applies to `holt init`");

  const overrides: HoltConfig = {};
  if (values.port !== undefined) overrides.port = parsePort(values.port);
  if (values.host !== undefined) overrides.host = values.host;
  if (values.out !== undefined) overrides.outputDir = values.out;
  // Length and character rules are the config validator's, as for --port.
  if (values["project-name"] !== undefined) overrides.projectName = values["project-name"];
  if (values.token !== undefined) overrides.token = values.token;

  return {
    command: "serve",
    overrides,
    ...(values.config !== undefined && { configFile: values.config }),
  };
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new CliUsageError(`--port must be a number (got "${raw}")`);
  // Range is checked by the config validator, with the same message as the file.
  return Number(raw);
}
