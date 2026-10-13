/**
 * Vite plugin: `import nitpick from "nitpick-notes/vite"`.
 *
 * Mounts the nitpick handler on Vite's dev server, so the extension talks
 * to the same origin as your app (e.g. http://localhost:5173/__nitpick/...)
 * and there is no second process to start.
 *
 * Notes:
 *  - `apply: "serve"`: the plugin does nothing during `vite build`.
 *  - Only types are imported from "vite", so this file has no runtime
 *    dependency on it. Vite is an optional peer dependency.
 *  - The middleware is added directly in configureServer (not in a returned
 *    post-hook), so it runs *before* Vite's own middlewares, including its
 *    CORS handling, which must not answer our preflights.
 *  - `port`/`host` config keys are ignored: Vite owns the socket. Run
 *    Vite on loopback (its default) to keep the API off the network.
 *  - Ending the session when the dev server closes: `closeBundle` is the
 *    hook Vite *awaits* inside `server.close()` (on SIGTERM, the `q`
 *    shortcut, and config restarts), and Vite calls `process.exit()` right
 *    after, so only an awaited hook reliably gets the end marker written.
 *    The httpServer "close" listener is a backup for hosts that close the
 *    http server directly; ending twice is a no-op.
 *  - Ctrl+C kills Vite without running any hook (Vite does not handle
 *    SIGINT, and a plugin should not hijack the host's signal handling), so
 *    the end marker may be missing then. That is harmless: every session has
 *    its own folder and the next capture starts a new one.
 */
import type { AddressInfo } from "node:net";
import type { Plugin, ViteDevServer } from "vite";
import { BASE_PATH } from "@nitpick/protocol";
import type { NitpickConfig } from "../config/types.js";
import { createNitpick, type Nitpick } from "../core.js";
import { LOG_PREFIX, type Logger } from "../log.js";

export interface NitpickViteOptions extends Omit<NitpickConfig, "port"> {
  /** Path to a config file (relative to the Vite root). Default: nitpick.config.json if present. */
  configFile?: string;
}

export default function nitpick(options: NitpickViteOptions = {}): Plugin {
  // One instance per plugin object. Vite re-evaluates vite.config on restart,
  // which calls nitpick() again, so each dev server gets its own.
  let instance: Nitpick | undefined;

  return {
    name: "nitpick",
    apply: "serve",

    async configureServer(server: ViteDevServer) {
      const logger = viteLogger(server);
      const { configFile, ...overrides } = options;
      const current = await createNitpick({
        cwd: server.config.root,
        overrides,
        overridesSource: "nitpick() Vite plugin options",
        ...(configFile !== undefined && { configFile }),
        logger,
      });
      instance = current;

      server.middlewares.use((req, res, next) => {
        current.handler(req, res).then((handled) => {
          if (!handled) next();
        }, next);
      });

      const httpServer = server.httpServer;
      if (!httpServer) {
        // Middleware mode: the host app owns the server and its lifecycle.
        logger.info(`mounted at ${BASE_PATH} (middleware mode; sessions end when the process exits)`);
        return;
      }
      httpServer.once("listening", () => {
        const origin = originOf(httpServer.address());
        logger.info(`API at ${origin}${BASE_PATH}, writing sessions to ${current.config.outputDir}`);
        logger.info(`Connect: set the nitpick extension's server URL to ${origin}`);
      });
      httpServer.once("close", () => {
        current.close().catch((err: unknown) => logger.error(`failed to close session: ${String(err)}`));
      });
    },

    async closeBundle() {
      await instance?.close();
    },
  };
}

/** Route our messages through Vite's logger so they match the dev-server output. */
function viteLogger(server: ViteDevServer): Logger {
  const vite = server.config.logger;
  return {
    info: (message) => vite.info(`${LOG_PREFIX} ${message}`, { timestamp: true }),
    warn: (message) => vite.warn(`${LOG_PREFIX} warning: ${message}`, { timestamp: true }),
    error: (message) => vite.error(`${LOG_PREFIX} error: ${message}`, { timestamp: true }),
  };
}

function originOf(address: string | AddressInfo | null): string {
  if (address === null || typeof address === "string") return "http://localhost";
  const wildcard = address.address === "::" || address.address === "0.0.0.0";
  const host = wildcard ? "localhost" : address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}
