/**
 * Standalone adapter: a bare node:http server that serves only holt.
 * This is what `npx holt-qa` runs.
 *
 * Responsibilities beyond "call the handler":
 *  - bind to config.host:config.port (loopback by default) and warn loudly
 *    if it is not loopback (docs/SECURITY.md, "Exposure on the network");
 *  - print a friendly banner with what to do next;
 *  - on SIGINT/SIGTERM, end the active session cleanly before exiting, so
 *    notes.md gets its end marker.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BASE_PATH, TOKEN_HEADER } from "@holt/protocol";
import type { Holt } from "../core.js";
import { isLoopbackHostname } from "../http/cors.js";
import { sendJson } from "../http/errors.js";
import { describeProject } from "../config/project.js";
import { createConsoleLogger, type Logger } from "../log.js";
import { VERSION } from "../version.js";

export interface StandaloneOptions {
  logger?: Logger;
  /** Install SIGINT/SIGTERM handlers that close the session and exit. The CLI sets this; tests do not. */
  handleSignals?: boolean;
}

export interface StandaloneServer {
  server: http.Server;
  /** Origin to put in the extension's settings, e.g. "http://127.0.0.1:4848". */
  url: string;
  port: number;
  /** End the session, stop accepting requests, and drop open connections. */
  close(): Promise<void>;
}

export async function startStandalone(holt: Holt, options: StandaloneOptions = {}): Promise<StandaloneServer> {
  const logger = options.logger ?? createConsoleLogger();
  const { config } = holt;

  // Refuse rather than warn: on a non-loopback interface, other machines
  // can reach us, and without a token the access checks would rest on
  // headers that non-browser clients can forge.
  if (!isLoopbackHostname(config.host) && config.token === null) {
    throw new Error(
      `Refusing to listen on "${config.host}" without a token: other machines on your network could ` +
        `write into ${config.outputDir}. Set "token" in holt.config.json (or pass --token), ` +
        `or use the default host 127.0.0.1.`,
    );
  }

  const server = http.createServer((req, res) => {
    void holt.handler(req, res).then((handled) => {
      if (!handled) {
        sendJson(res, 404, {
          ok: false,
          error: { code: "not-found", message: `This server only serves ${BASE_PATH}/*` },
        });
      }
    });
  });

  await listen(server, config.port, config.host);
  const { port } = server.address() as AddressInfo;
  // The URL to *connect* to. For a wildcard bind that is loopback: the
  // extension only has permission for 127.0.0.1/localhost, and the Host
  // check would reject "0.0.0.0" anyway.
  const connectHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host === "::" ? "::1" : config.host;
  const url = `http://${formatHost(connectHost)}:${port}`;

  if (!isLoopbackHostname(config.host)) {
    logger.warn(
      `listening on ${config.host}, which is NOT loopback. Other machines on your network can reach ` +
        `this server; only requests with the token are accepted from them.`,
    );
  }
  printBanner(logger, holt, url);

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await holt.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close() waits for keep-alive connections to go idle; don't.
        server.closeAllConnections();
      });
    })();
    return closing;
  };

  if (options.handleSignals) {
    const onSignal = (signal: NodeJS.Signals): void => {
      if (closing) {
        // Second Ctrl+C: the user means it.
        process.exit(1);
      }
      logger.info(`${signal} received, closing session...`);
      close().then(
        () => process.exit(0),
        (err: unknown) => {
          logger.error(`failed to close cleanly: ${String(err)}`);
          process.exit(1);
        },
      );
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return { server, url, port, close };
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(`Port ${port} on ${host} is already in use. Is holt already running? Try --port <other>.`),
        );
      } else {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/** IPv6 literals need brackets inside a URL. */
function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function printBanner(logger: Logger, { config }: Holt, url: string): void {
  logger.info(`v${VERSION} serving ${describeProject(config.project)} at ${url}${BASE_PATH}`);
  logger.info(`Writing sessions to ${config.outputDir}`);
  if (config.configFile) logger.info(`Config: ${config.configFile}`);
  logger.info(`Connect: open the holt extension's side panel and set the server URL to ${url}`);
  if (config.token !== null) {
    logger.info(`A token is required (${TOKEN_HEADER}); enter the same token in the extension settings.`);
  }
  logger.info("Press Ctrl+C to stop; the active session is closed cleanly.");
}
