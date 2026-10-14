/**
 * The standalone server's own behaviour (handler.test.ts uses it as a
 * vehicle for the API): a clear message when the port is taken, the URL it
 * tells the user to connect to, and shutting down twice.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { BASE_PATH, CLIENT_HEADER, CLIENT_HEADER_VALUE, type SessionResponse } from "@holt/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HoltConfig } from "../config/types.js";
import { createHolt } from "../core.js";
import { silentLogger } from "../log.js";
import { startStandalone, type StandaloneServer } from "./standalone.js";

/** Some CI containers have no IPv6 loopback. */
const hasIpv6Loopback = Object.values(networkInterfaces())
  .flat()
  .some((iface) => iface?.internal && iface.family === "IPv6" && iface.address === "::1");

const EXT_HEADERS = { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", [CLIENT_HEADER]: CLIENT_HEADER_VALUE };

let dirs: string[] = [];
let servers: StandaloneServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
  servers = [];
});

async function start(overrides: HoltConfig = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "holt-standalone-"));
  dirs.push(dir);
  const holt = await createHolt({ cwd: dir, overrides: { port: 0, ...overrides }, logger: silentLogger });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const server = await startStandalone(holt, { logger });
  servers.push(server);
  return { server, logger, lines: () => logger.info.mock.calls.map((c) => String(c[0])).join("\n") };
}

describe("startStandalone", () => {
  it("explains a port that is already in use instead of throwing EADDRINUSE", async () => {
    const { server } = await start();
    await expect(start({ port: server.port })).rejects.toThrow(
      new RegExp(`Port ${server.port} on 127\\.0\\.0\\.1 is already in use\\. Is holt already running\\?`),
    );
  });

  it("prints the URL to set in the extension (not the default one) and mentions the token", async () => {
    const { server, lines } = await start({ token: "t0ken" });
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(lines()).toContain(`at ${server.url}${BASE_PATH}`);
    expect(lines()).toContain(`set the server URL to ${server.url}`);
    expect(lines()).toMatch(/A token is required/);
    expect(lines()).not.toContain("t0ken"); // the secret itself is never printed
  });

  it.skipIf(!hasIpv6Loopback)("brackets an IPv6 loopback host in the URL", async () => {
    const { server } = await start({ host: "::1" });
    expect(server.url).toBe(`http://[::1]:${server.port}`);
    const res = await fetch(`${server.url}${BASE_PATH}/status`, { headers: EXT_HEADERS });
    expect(res.status).toBe(200);
  });

  it("close() twice ends the session once and resolves both times", async () => {
    const { server } = await start();
    const res = await fetch(`${server.url}${BASE_PATH}/session/start`, { method: "POST", headers: EXT_HEADERS });
    const { session } = (await res.json()) as SessionResponse;
    await Promise.all([server.close(), server.close()]);
    await server.close();
    const notes = await readFile(path.join(session?.dir ?? "", "notes.md"), "utf8");
    expect(notes.match(/_Session ended at/g)).toHaveLength(1);
    await expect(fetch(`${server.url}${BASE_PATH}/status`, { headers: EXT_HEADERS })).rejects.toThrow();
  });
});
