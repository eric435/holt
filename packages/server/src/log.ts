/**
 * A tiny logger: three levels, a `[nitpick]` prefix, nothing else.
 *
 * It is an interface rather than direct `console` calls so that:
 *  - the Vite adapter can route messages through Vite's own logger (keeps
 *    the dev-server output tidy), and
 *  - tests can pass `silentLogger` or a spy instead of spamming the console.
 *
 * (ARCHITECTURE.md sketches this under cli/, but the core and both adapters
 * log too, and the core should not import from the CLI layer.)
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const LOG_PREFIX = "[nitpick]";

/** Logs to the given console-like sink (default: the real console). */
export function createConsoleLogger(sink: Pick<Console, "log" | "warn" | "error"> = console): Logger {
  return {
    info: (message) => sink.log(`${LOG_PREFIX} ${message}`),
    warn: (message) => sink.warn(`${LOG_PREFIX} warning: ${message}`),
    error: (message) => sink.error(`${LOG_PREFIX} error: ${message}`),
  };
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
