/**
 * Vite plugin: `import holt from "@velvet-thunder/holt/vite"`.
 *
 * Mounts the holt handler on Vite's dev server, so the extension talks
 * to the same origin as your app (e.g. http://localhost:5173/__holt/...)
 * and there is no second process to start.
 *
 * Notes:
 *  - `apply: "serve"`: the plugin does nothing during `vite build`.
 *  - Only types are imported from "vite", so this file has no runtime
 *    dependency on it. Vite is an optional peer dependency.
 *  - Our middlewares must run *before* Vite's own: its CORS handling must
 *    not answer our preflights, and its static file serving must not serve
 *    the session folders or holt.config.json (see output-guard.ts). Adding
 *    them in configureServer (not in a returned post-hook) was enough up to
 *    Vite 6, but Vite 7 installs its CORS and host-check middlewares before
 *    configureServer runs, so we move ours to the front of the stack.
 *    holt's handler does its own CORS and Host checks (http/cors.ts).
 *  - `port`/`host` config keys are ignored: Vite owns the socket. Under
 *    Vite, holt's API is loopback-only by design. The Host check
 *    (http/cors.ts) accepts loopback names plus `config.host`, which
 *    nothing binds under Vite and which normally stays at its 127.0.0.1
 *    default, so a client on another machine, sending Vite's LAN address
 *    as its Host, is refused with or without a token. When `vite --host`
 *    puts the dev server on the network we warn and point at the
 *    standalone server, the supported way to use holt remotely
 *    (`--host <addr> --token ...`).
 *  - Requires Vite 5.4.12+ or 6.0.9+ (the peer range is
 *    `^5.4.12 || ^6.0.9 || ^7.0.0 || ^8.0.0`, the majors CI tests): older
 *    versions, including 6.0.0-6.0.8, answer every request with
 *    `Access-Control-Allow-Origin: *` (GHSA-vg6x-rcgg-rjx6), letting any
 *    web page read your app's source and the session files they serve. A
 *    plain `>=5.4.12` would admit those 6.0.x releases.
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
import path from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";
import { BASE_PATH, CONFIG_FILE_NAME } from "@holt/protocol";
import { describeProject } from "../config/project.js";
import type { HoltConfig } from "../config/types.js";
import { createHolt, type Holt } from "../core.js";
import { isLoopbackAddress } from "../http/cors.js";
import { LOG_PREFIX, type Logger } from "../log.js";
import { requestTouchesProtectedPath, type ProtectedPathOptions } from "./output-guard.js";

export interface HoltViteOptions extends Omit<HoltConfig, "port"> {
  /** Path to a config file (relative to the Vite root). Default: holt.config.json if present. */
  configFile?: string;
}

export default function holt(options: HoltViteOptions = {}): Plugin {
  // One instance per plugin object. Vite re-evaluates vite.config on restart,
  // which calls holt() again, so each dev server gets its own.
  let instance: Holt | undefined;

  return {
    name: "holt",
    apply: "serve",

    async configureServer(server: ViteDevServer) {
      const logger = viteLogger(server);
      const { configFile, ...overrides } = options;
      const current = await createHolt({
        cwd: server.config.root,
        overrides,
        overridesSource: "holt() Vite plugin options",
        ...(configFile !== undefined && { configFile }),
        logger,
      });
      instance = current;

      // The config file may hold the token. Protect the default location
      // even when it is missing now: it can be created while Vite runs.
      const protectedFiles = [path.join(current.config.root, CONFIG_FILE_NAME)];
      if (current.config.configFile !== null) protectedFiles.push(current.config.configFile);
      const guard: ProtectedPathOptions = {
        root: server.config.root,
        outputDir: current.config.outputDir,
        protectedFiles,
        publicDir: server.config.publicDir,
        base: server.config.base,
      };
      // Connect's `stack` (public, though undocumented). Test doubles may lack it.
      const stack = server.middlewares.stack as Connect.ServerStackItem[] | undefined;
      const firstOurs = stack?.length ?? 0;
      server.middlewares.use((req, res, next) => {
        if (!requestTouchesProtectedPath(req.url, guard)) return next();
        // Same response as any missing file, so their existence is not revealed.
        res.statusCode = 404;
        res.end("Not found");
      });

      server.middlewares.use((req, res, next) => {
        current.handler(req, res).then((handled) => {
          if (!handled) next();
        }, next);
      });
      // Ahead of Vite's own middlewares, including those Vite 7+ installs
      // before configureServer runs (see the header).
      stack?.unshift(...stack.splice(firstOurs));

      const project = describeProject(current.config.project);
      const httpServer = server.httpServer;
      if (!httpServer) {
        // Middleware mode: the host app owns the server and its lifecycle.
        logger.info(
          `serving ${project}, mounted at ${BASE_PATH} (middleware mode; sessions end when the process exits)`,
        );
        return;
      }
      httpServer.once("listening", () => {
        const address = httpServer.address();
        if (address && typeof address !== "string" && !isLoopbackAddress(address.address)) {
          logger.warn(
            `Vite is listening on ${address.address}, which other machines can reach. Under Vite, holt ` +
              `only answers requests from this machine (a token does not change that). To use holt from ` +
              `another machine, run the standalone server instead: npx holt --host <address> --token <secret>.`,
          );
        }
        const origin = originOf(address);
        logger.info(`serving ${project} at ${origin}${BASE_PATH}, writing sessions to ${current.config.outputDir}`);
        // The extension probes the origin of the page it captures (only on
        // loopback), so pages Vite serves need no setup. Pages served by
        // another backend that only uses Vite for assets don't come from
        // this origin: those need the fallback URL.
        logger.info(`Connect: nothing to set up. The holt extension detects holt on pages served from ${origin}.`);
        logger.info(
          `If your pages come from another server (Vite behind Rails, Laravel, Django, ...), set the extension's fallback server URL to ${origin}.`,
        );
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
