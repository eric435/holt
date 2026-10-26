/**
 * The Vite adapter, tested against a stub of the parts of ViteDevServer it
 * uses: `config.root`, `config.logger`, `middlewares.use`, and `httpServer`
 * (an EventEmitter is enough to fire "listening" and "close").
 */
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  type SessionResponse,
  type StatusResponse,
} from "@holt/protocol";
import type { Connect, Plugin, ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import holt from "./vite.js";

let root: string;
let appServer: http.Server | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "holt-vite-"));
});
afterEach(async () => {
  appServer?.closeAllConnections();
  appServer?.close();
  appServer = undefined;
  await rm(root, { recursive: true, force: true });
});

function stubServer(httpServer: EventEmitter | null = new EventEmitter()) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const use = vi.fn();
  const server = { config: { root, logger }, middlewares: { use }, httpServer } as unknown as ViteDevServer;
  return { server, use, logger, httpServer };
}

async function configure(plugin: Plugin, server: ViteDevServer): Promise<void> {
  const hook = plugin.configureServer;
  const fn = typeof hook === "function" ? hook : hook?.handler;
  await fn?.call({} as never, server);
}

const EXT_HEADERS = {
  origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
  [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
};

/**
 * Serve every mounted middleware, in order, on a real port, like connect
 * would, with a 418 "app" fallback standing in for the rest of Vite.
 */
async function serveMiddlewares(use: ReturnType<typeof vi.fn>): Promise<string> {
  const stack = use.mock.calls.map((call) => call[0] as Connect.NextHandleFunction);
  appServer = http.createServer((req, res) => {
    const run = (i: number): void => {
      const middleware = stack[i];
      if (!middleware) {
        res.statusCode = 418;
        res.end("app");
        return;
      }
      middleware(req, res, () => run(i + 1));
    };
    run(0);
  });
  await new Promise<void>((resolve) => appServer?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;
}

describe("holt() Vite plugin", () => {
  it("only applies to the dev server", () => {
    const plugin = holt();
    expect(plugin.name).toBe("holt");
    expect(plugin.apply).toBe("serve");
  });

  it("mounts middlewares that handle /__holt and fall through for everything else", async () => {
    const { server, use } = stubServer();
    await configure(holt(), server);
    expect(use).toHaveBeenCalledTimes(2); // output-dir guard + API handler

    const origin = await serveMiddlewares(use);
    const app = await fetch(`${origin}/src/main.ts`);
    expect(app.status).toBe(418);
    const status = await fetch(`${origin}${BASE_PATH}/status`, { headers: EXT_HEADERS });
    expect(status.status).toBe(200);
  });

  it("resolves outputDir against the Vite root and passes options through", async () => {
    const { server, use } = stubServer();
    await configure(holt({ outputDir: "notes", sessionTitle: "Vite QA" }), server);
    const origin = await serveMiddlewares(use);

    const res = await fetch(`${origin}${BASE_PATH}/session/start`, {
      method: "POST",
      headers: EXT_HEADERS,
    });
    const { session } = (await res.json()) as SessionResponse;
    expect(session?.dir.startsWith(path.join(root, "notes"))).toBe(true);
    expect(await readFile(path.join(session?.dir ?? "", "notes.md"), "utf8")).toMatch(/^# Vite QA /);
  });

  it("logs the project and API URL once the dev server is listening", async () => {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "vite-app" }));
    const httpServer = Object.assign(new EventEmitter(), {
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 5173 }),
    });
    const { server, logger } = stubServer(httpServer);
    await configure(holt(), server);
    httpServer.emit("listening");
    const messages = logger.info.mock.calls.map((call) => String(call[0]));
    expect(
      messages.some((m) => m.includes(`serving vite-app (from package.json) at http://127.0.0.1:5173${BASE_PATH}`)),
    ).toBe(true);
    expect(messages.every((m) => m.startsWith("[holt]"))).toBe(true);
    // The extension auto-detects holt on this origin; the URL is only needed as a fallback.
    expect(messages.some((m) => m.includes("detects holt on pages served from http://127.0.0.1:5173"))).toBe(true);
    expect(messages.some((m) => m.includes("fallback server URL to http://127.0.0.1:5173"))).toBe(true);
    expect(messages.some((m) => m.includes("set the holt extension's server URL"))).toBe(false);
  });

  it("reports projectName from plugin options in /status", async () => {
    const { server, use } = stubServer();
    await configure(holt({ projectName: "storefront" }), server);
    const origin = await serveMiddlewares(use);
    const res = await fetch(`${origin}${BASE_PATH}/status`, { headers: EXT_HEADERS });
    expect(((await res.json()) as StatusResponse).project).toEqual({ name: "storefront", source: "config" });
  });

  it("ends the active session when the dev server closes", async () => {
    const { server, use, httpServer } = stubServer();
    await configure(holt(), server);
    const origin = await serveMiddlewares(use);

    const res = await fetch(`${origin}${BASE_PATH}/session/start`, {
      method: "POST",
      headers: EXT_HEADERS,
    });
    const { session } = (await res.json()) as SessionResponse;
    const notesPath = path.join(session?.dir ?? "", "notes.md");
    expect(await readFile(notesPath, "utf8")).not.toContain("Session ended");

    httpServer?.emit("close");
    await vi.waitFor(async () => {
      expect(await readFile(notesPath, "utf8")).toContain("_Session ended at");
    });
  });

  it("ends the active session in closeBundle, which Vite awaits during server.close()", async () => {
    const { server, use } = stubServer(null);
    const plugin = holt();
    await configure(plugin, server);
    const origin = await serveMiddlewares(use);

    const res = await fetch(`${origin}${BASE_PATH}/session/start`, {
      method: "POST",
      headers: EXT_HEADERS,
    });
    const { session } = (await res.json()) as SessionResponse;

    const hook = plugin.closeBundle;
    const fn = typeof hook === "function" ? hook : hook?.handler;
    await fn?.call({} as never);
    // Awaited, so the end marker is on disk as soon as the hook resolves.
    expect(await readFile(path.join(session?.dir ?? "", "notes.md"), "utf8")).toContain("_Session ended at");
  });

  it("works in middleware mode (no httpServer)", async () => {
    const { server, use } = stubServer(null);
    await configure(holt(), server);
    expect(use).toHaveBeenCalledTimes(2);
  });

  it("does not let Vite serve the output directory", async () => {
    const { server, use } = stubServer();
    await configure(holt(), server);
    const origin = await serveMiddlewares(use);

    const start = await fetch(`${origin}${BASE_PATH}/session/start`, { method: "POST", headers: EXT_HEADERS });
    const { session } = (await start.json()) as SessionResponse;
    const id = session?.id ?? "";

    for (const p of [`/qa/${id}/notes.md`, `/qa/.gitignore`, `//qa/${id}/notes.md`, `/%71a/${id}/notes.md`, `/QA/${id}/notes.md?raw`]) {
      const res = await fetch(`${origin}${p}`);
      expect(res.status, p).toBe(404);
    }
    // Everything else still reaches Vite.
    expect((await fetch(`${origin}/qa-notes.html`)).status).toBe(418);
    expect((await fetch(`${origin}/src/qa/x.ts`)).status).toBe(418);
  });

  it("does not let Vite serve holt.config.json (it may hold the token)", async () => {
    await writeFile(path.join(root, "holt.config.json"), JSON.stringify({ token: "s3cret" }));
    const { server, use } = stubServer();
    await configure(holt(), server);
    const origin = await serveMiddlewares(use);
    for (const p of ["/holt.config.json", "/holt.config.json?import", "/holt%2Econfig.json", "/HOLT.config.json", `/@fs${path.join(root, "holt.config.json")}`]) {
      const res = await fetch(`${origin}${p}`);
      expect(res.status, p).toBe(404);
      expect(await res.text(), p).not.toContain("s3cret");
    }
    expect((await fetch(`${origin}/holt.config.json.html`)).status).toBe(418);
  });

  it("guards the default holt.config.json even when it did not exist at startup, and a custom config file", async () => {
    await writeFile(path.join(root, "custom.json"), "{}");
    const { server, use } = stubServer();
    await configure(holt({ configFile: "custom.json" }), server);
    const origin = await serveMiddlewares(use);
    expect((await fetch(`${origin}/custom.json`)).status).toBe(404);
    expect((await fetch(`${origin}/holt.config.json`)).status).toBe(404);
    expect((await fetch(`${origin}/other.json`)).status).toBe(418);
  });

  it("warns when Vite listens on a non-loopback address, token or not, and points at the standalone server", async () => {
    // Under Vite, holt's API is loopback-only (see the Host check in
    // http/cors.ts), so a token does not make it reachable from the LAN.
    for (const options of [{}, { token: "tok-123" }]) {
      const lanServer = Object.assign(new EventEmitter(), {
        address: () => ({ address: "0.0.0.0", family: "IPv4", port: 5173 }),
      });
      const { server, logger } = stubServer(lanServer);
      await configure(holt(options), server);
      lanServer.emit("listening");
      const warnings = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnings).toMatch(/0\.0\.0\.0, which other machines can reach/);
      expect(warnings).toMatch(/only answers requests from this machine/);
      expect(warnings).toMatch(/npx holt --host <address> --token <secret>/);
      expect(warnings).not.toContain("tok-123");
    }

    // On loopback: no warning.
    const local = stubServer(
      Object.assign(new EventEmitter(), { address: () => ({ address: "127.0.0.1", family: "IPv4", port: 5173 }) }),
    );
    await configure(holt({ token: "secret" }), local.server);
    local.httpServer?.emit("listening");
    expect(local.logger.warn).not.toHaveBeenCalled();
  });

  it("rejects invalid options with a clear error", async () => {
    const { server } = stubServer();
    await expect(configure(holt({ outputDir: 42 as unknown as string }), server)).rejects.toThrow(
      /holt\(\) Vite plugin options[\s\S]*"outputDir"/,
    );
  });
});

describe("holt() Vite plugin: middleware order and shutdown", () => {
  const callHook = async (plugin: Plugin, name: "closeBundle") => {
    const hook = plugin[name];
    const fn = typeof hook === "function" ? hook : hook?.handler;
    await fn?.call({} as never);
  };

  /** Run one mounted middleware against a bare request; say whether it called next() or answered. */
  function runMiddleware(use: ReturnType<typeof vi.fn>, index: number, url: string) {
    const middleware = use.mock.calls[index]?.[0] as Connect.NextHandleFunction;
    const res = Object.assign(new EventEmitter(), { statusCode: 200, end: vi.fn(), setHeader: vi.fn() });
    const next = vi.fn();
    middleware({ url, method: "GET", headers: {} } as Connect.IncomingMessage, res as never, next);
    return { next, res };
  }

  it("mounts the output-dir guard first and the API handler second", async () => {
    const { server, use } = stubServer();
    await configure(holt(), server);
    // The first middleware answers 404 for the session folder itself...
    const guarded = runMiddleware(use, 0, "/qa/2026-10-13-075200/notes.md");
    expect(guarded.next).not.toHaveBeenCalled();
    expect(guarded.res.statusCode).toBe(404);
    // ...and passes the API through untouched: it is not the handler.
    expect(runMiddleware(use, 0, `${BASE_PATH}/status`).next).toHaveBeenCalledTimes(1);
    // The second one is the handler: it falls through for the app's own paths.
    const app = runMiddleware(use, 1, "/src/main.ts");
    await vi.waitFor(() => expect(app.next).toHaveBeenCalledTimes(1));
    expect(app.res.end).not.toHaveBeenCalled();
  });

  it("guards the output dir even for paths under the API prefix or with dot segments", async () => {
    const { server, use } = stubServer();
    await configure(holt(), server);
    const origin = await serveMiddlewares(use);
    await fetch(`${origin}${BASE_PATH}/session/start`, { method: "POST", headers: EXT_HEADERS });
    for (const p of [`${BASE_PATH}/../qa/.gitignore`, `/src/../qa/.gitignore`]) {
      const res = await fetch(`${origin}${p}`);
      expect(res.status, p).not.toBe(200);
      expect(await res.text(), p).not.toContain("*");
    }
  });

  it("closeBundle before configureServer (vite build, or a failed start) is a no-op", async () => {
    await expect(callHook(holt(), "closeBundle")).resolves.toBeUndefined();
  });

  it("ending twice (closeBundle, then the http server's close) writes one end marker", async () => {
    const { server, use, httpServer } = stubServer();
    const plugin = holt();
    await configure(plugin, server);
    const origin = await serveMiddlewares(use);
    const res = await fetch(`${origin}${BASE_PATH}/session/start`, { method: "POST", headers: EXT_HEADERS });
    const { session } = (await res.json()) as SessionResponse;
    const notesPath = path.join(session?.dir ?? "", "notes.md");

    await callHook(plugin, "closeBundle");
    await callHook(plugin, "closeBundle");
    httpServer?.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await readFile(notesPath, "utf8")).match(/_Session ended at/g)).toHaveLength(1);
  });

  it.each([
    [{ address: "::1", family: "IPv6", port: 5173 }, "http://[::1]:5173"],
    [{ address: "::", family: "IPv6", port: 5173 }, "http://localhost:5173"],
    [{ address: "0.0.0.0", family: "IPv4", port: 4000 }, "http://localhost:4000"],
  ])("prints a usable origin when Vite listens on %j", async (address, origin) => {
    const httpServer = Object.assign(new EventEmitter(), { address: () => address });
    const { server, logger } = stubServer(httpServer);
    await configure(holt({ token: "t" }), server);
    httpServer.emit("listening");
    expect(logger.info.mock.calls.map((c) => String(c[0])).join("\n")).toContain(`at ${origin}${BASE_PATH}`);
  });
});
