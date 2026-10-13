/**
 * The Vite adapter, tested against a stub of the parts of ViteDevServer it
 * uses: `config.root`, `config.logger`, `middlewares.use`, and `httpServer`
 * (an EventEmitter is enough to fire "listening" and "close").
 */
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BASE_PATH, CLIENT_HEADER, CLIENT_HEADER_VALUE, type SessionResponse } from "@nitpick/protocol";
import type { Connect, Plugin, ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nitpick from "./vite.js";

let root: string;
let appServer: http.Server | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nitpick-vite-"));
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

/** Serve the mounted middleware on a real port, with a 418 "app" fallback. */
async function serveMiddleware(middleware: Connect.NextHandleFunction): Promise<string> {
  appServer = http.createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 418;
      res.end("app");
    });
  });
  await new Promise<void>((resolve) => appServer?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;
}

describe("nitpick() Vite plugin", () => {
  it("only applies to the dev server", () => {
    const plugin = nitpick();
    expect(plugin.name).toBe("nitpick");
    expect(plugin.apply).toBe("serve");
  });

  it("mounts one middleware that handles /__nitpick and falls through for everything else", async () => {
    const { server, use } = stubServer();
    await configure(nitpick(), server);
    expect(use).toHaveBeenCalledTimes(1);

    const origin = await serveMiddleware(use.mock.calls[0]?.[0] as Connect.NextHandleFunction);
    const app = await fetch(`${origin}/src/main.ts`);
    expect(app.status).toBe(418);
    const status = await fetch(`${origin}${BASE_PATH}/status`, { headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE } });
    expect(status.status).toBe(200);
  });

  it("resolves outputDir against the Vite root and passes options through", async () => {
    const { server, use } = stubServer();
    await configure(nitpick({ outputDir: "notes", sessionTitle: "Vite QA" }), server);
    const origin = await serveMiddleware(use.mock.calls[0]?.[0] as Connect.NextHandleFunction);

    const res = await fetch(`${origin}${BASE_PATH}/session/start`, {
      method: "POST",
      headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
    });
    const { session } = (await res.json()) as SessionResponse;
    expect(session?.dir.startsWith(path.join(root, "notes"))).toBe(true);
    expect(await readFile(path.join(session?.dir ?? "", "notes.md"), "utf8")).toMatch(/^# Vite QA /);
  });

  it("logs the API URL once the dev server is listening", async () => {
    const httpServer = Object.assign(new EventEmitter(), {
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 5173 }),
    });
    const { server, logger } = stubServer(httpServer);
    await configure(nitpick(), server);
    httpServer.emit("listening");
    const messages = logger.info.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes(`http://127.0.0.1:5173${BASE_PATH}`))).toBe(true);
    expect(messages.every((m) => m.startsWith("[nitpick]"))).toBe(true);
  });

  it("ends the active session when the dev server closes", async () => {
    const { server, use, httpServer } = stubServer();
    await configure(nitpick(), server);
    const origin = await serveMiddleware(use.mock.calls[0]?.[0] as Connect.NextHandleFunction);

    const res = await fetch(`${origin}${BASE_PATH}/session/start`, {
      method: "POST",
      headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
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
    const plugin = nitpick();
    await configure(plugin, server);
    const origin = await serveMiddleware(use.mock.calls[0]?.[0] as Connect.NextHandleFunction);

    const res = await fetch(`${origin}${BASE_PATH}/session/start`, {
      method: "POST",
      headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
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
    await configure(nitpick(), server);
    expect(use).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid options with a clear error", async () => {
    const { server } = stubServer();
    await expect(configure(nitpick({ outputDir: 42 as unknown as string }), server)).rejects.toThrow(
      /nitpick\(\) Vite plugin options[\s\S]*"outputDir"/,
    );
  });
});
