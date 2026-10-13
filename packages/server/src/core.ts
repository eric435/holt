/**
 * createNitpick(): wires config, session store and HTTP handler together.
 *
 * This is the one place that knows how the layers fit. Everything it
 * returns is host-agnostic: the standalone adapter and the Vite adapter
 * both start from here and only differ in how they mount `handler` and when
 * they call `close()`.
 *
 * (It lives here rather than in index.ts so the Vite entry can import it
 * without pulling in the whole public API module.)
 */
import { loadConfig } from "./config/load.js";
import type { NitpickConfig, ResolvedConfig } from "./config/types.js";
import { createHandler, type NitpickHandler } from "./http/handler.js";
import { createConsoleLogger, type Logger } from "./log.js";
import { SessionStore } from "./session/store.js";
import { pluralEntries } from "./session/markdown.js";

export interface CreateNitpickOptions {
  /** Project root: where nitpick.config.json is looked up and paths resolve. Default: process.cwd(). */
  cwd?: string;
  /** Explicit config file path (must exist). Default: <cwd>/nitpick.config.json if present. */
  configFile?: string;
  /** Highest-precedence config values (CLI flags, plugin options). */
  overrides?: NitpickConfig;
  /** Label for errors in `overrides`, e.g. "command line flags". */
  overridesSource?: string;
  logger?: Logger;
}

export interface Nitpick {
  /** Mount this on any node:http-compatible server. See http/handler.ts. */
  handler: NitpickHandler;
  sessions: SessionStore;
  config: ResolvedConfig;
  /** End the active session (if any). Safe to call more than once. */
  close(): Promise<void>;
}

export async function createNitpick(options: CreateNitpickOptions = {}): Promise<Nitpick> {
  const logger = options.logger ?? createConsoleLogger();
  const { config, warnings } = await loadConfig(options.cwd ?? process.cwd(), options.overrides, {
    ...(options.configFile !== undefined && { configFile: options.configFile }),
    ...(options.overridesSource !== undefined && { overridesSource: options.overridesSource }),
  });
  for (const warning of warnings) logger.warn(warning);

  const sessions = new SessionStore({
    root: config.root,
    outputDir: config.outputDir,
    defaultTitle: config.sessionTitle,
  });
  const handler = createHandler({ config, sessions, logger });

  return {
    handler,
    sessions,
    config,
    async close() {
      const ended = await sessions.stop();
      if (ended) logger.info(`Ended session ${ended.markdownFile} (${pluralEntries(ended.entryCount)})`);
    },
  };
}
