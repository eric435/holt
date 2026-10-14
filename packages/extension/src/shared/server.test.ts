/**
 * The probe that decides "is holt on this tab's origin?" (shared/server.ts),
 * driven through `resolveServerForUrl` with a stubbed `fetch`.
 * server-resolve.test.ts covers the decision table with a fake probe; this
 * covers the real probe: what counts as holt, and that the token is never
 * sent to an origin we are only asking.
 *
 * There is no `chrome` here, so the probe cache in storage.session throws on
 * every access; server.ts swallows that by design ("a broken cache only costs
 * extra probes"), which is also tested.
 */
import { BASE_PATH, CLIENT_HEADER, CLIENT_HEADER_VALUE, TOKEN_HEADER } from "@holt/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoltNotAnsweringError } from "./server-resolve.js";
import { resolveServerForTab, resolveServerForUrl } from "./server.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings.js";

const VITE = "http://localhost:5173";
const FALLBACK = "http://127.0.0.1:4848";
const settings: Settings = { ...DEFAULT_SETTINGS, serverMode: "auto", serverUrl: FALLBACK, token: "s3cret" };
const holtStatus = { ok: true, name: "holt", version: "0.1.0", session: null, config: {} };

let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the auto-detect probe", () => {
  it("asks <origin>/__holt/status with the client header and WITHOUT the token", async () => {
    fetchMock.mockResolvedValue(json(holtStatus));
    const resolved = await resolveServerForUrl(`${VITE}/checkout`, settings);
    expect(resolved).toMatchObject({ serverUrl: VITE, source: "tab", status: { name: "holt" } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${VITE}${BASE_PATH}/status`);
    const headers = init.headers as Record<string, string>;
    expect(headers[CLIENT_HEADER]).toBe(CLIENT_HEADER_VALUE);
    expect(headers).not.toHaveProperty(TOKEN_HEADER);
  });

  it("counts holt's own 'forbidden' (a server that wants the token) as holt, without a status", async () => {
    fetchMock.mockResolvedValue(json({ ok: false, error: { code: "forbidden", message: 'Missing or wrong "x-holt-token" header' } }, 403));
    expect(await resolveServerForUrl(`${VITE}/`, settings)).toEqual({ serverUrl: VITE, source: "tab" });
  });

  it.each([
    ["some other app's JSON that says ok", json({ ok: true })],
    ["another tool called something else", json({ ok: true, name: "not-holt" })],
    ["an SPA catch-all answering every path with HTML", new Response("<!doctype html><title>App</title>", { status: 200 })],
    ["a 404 page", new Response("Not found", { status: 404 })],
    ["a holt-shaped error that is not 'forbidden'", json({ ok: false, error: { code: "not-found", message: "No route" } }, 404)],
    ["a 500 with an empty body", new Response("", { status: 500 })],
  ])("does not count %s as holt", async (_what, response) => {
    fetchMock.mockResolvedValue(response);
    expect(await resolveServerForUrl(`${VITE}/`, settings)).toEqual({ serverUrl: FALLBACK, source: "fallback" });
  });

  it("falls back when nothing listens (connection refused)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await resolveServerForUrl(`${VITE}/`, settings)).toEqual({ serverUrl: FALLBACK, source: "fallback" });
  });

  it("never probes in fixed mode, or for pages that are not on this machine", async () => {
    await resolveServerForUrl(`${VITE}/`, { ...settings, serverMode: "fixed" });
    await resolveServerForUrl("https://example.com/", settings);
    await resolveServerForUrl("http://192.168.1.20:5173/", settings);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without a usable probe cache (no storage), it just probes again", async () => {
    fetchMock.mockImplementation(async () => json(holtStatus));
    await resolveServerForUrl(`${VITE}/`, settings);
    await resolveServerForUrl(`${VITE}/`, settings);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("resolveServerForTab", () => {
  it("uses the tab's url, or its pendingUrl while it is still loading", async () => {
    fetchMock.mockImplementation(async () => json(holtStatus));
    await resolveServerForTab({ url: "", pendingUrl: `${VITE}/next` }, settings);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${VITE}${BASE_PATH}/status`);
    await resolveServerForTab({ url: "http://localhost:3000/", pendingUrl: `${VITE}/next` }, settings);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`http://localhost:3000${BASE_PATH}/status`);
  });

  it("no tab (or an unreadable URL) means the fallback, without probing", async () => {
    expect(await resolveServerForTab(undefined, settings)).toEqual({ serverUrl: FALLBACK, source: "fallback" });
    expect(await resolveServerForTab({}, settings)).toEqual({ serverUrl: FALLBACK, source: "fallback" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("with storage.session: an origin that has been holt", () => {
  let session: Map<string, unknown>;
  beforeEach(() => {
    session = new Map();
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: async (key: string) => (session.has(key) ? { [key]: structuredClone(session.get(key)) } : {}),
          set: async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) session.set(k, structuredClone(v));
          },
        },
      },
    });
  });

  it("is remembered once it answers, and a later failed probe is an error, not the fallback", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      fetchMock.mockResolvedValue(json(holtStatus));
      expect(await resolveServerForUrl(`${VITE}/`, settings)).toMatchObject({ serverUrl: VITE, source: "tab" });
      expect(session.get("holtOrigins")).toEqual([VITE]);

      // Vite restarting: nothing listens for a moment. Past the positive cache's lifetime:
      vi.setSystemTime(1_000_000 + 60_000);
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(resolveServerForUrl(`${VITE}/`, settings)).rejects.toBeInstanceOf(HoltNotAnsweringError);
      // ... and from the negative cache entry too, without probing again.
      const calls = fetchMock.mock.calls.length;
      await expect(resolveServerForUrl(`${VITE}/`, settings)).rejects.toThrow(/isn't answering/);
      expect(fetchMock.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an origin that never answered as holt still falls back", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await resolveServerForUrl("http://localhost:3000/", settings)).toEqual({ serverUrl: FALLBACK, source: "fallback" });
    expect(session.get("holtOrigins")).toBeUndefined();
  });
});
