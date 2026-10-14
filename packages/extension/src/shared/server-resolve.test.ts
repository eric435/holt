import type { StatusResponse } from "@holt/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  HoltNotAnsweringError,
  PROBE_TTL_FAILED_MS,
  PROBE_TTL_OK_MS,
  addHoltOrigin,
  isLocalPage,
  probeableOrigin,
  resolveServer,
  updateProbeCache,
  type ProbeCache,
  type ProbeCacheStore,
  type ResolveInput,
} from "./server-resolve.js";

const FALLBACK = "http://127.0.0.1:4848";
const VITE = "http://localhost:5173";
const status = { ok: true, name: "holt", version: "0.1.0" } as StatusResponse;

function memoryCache(initial: ProbeCache = {}, holt: string[] = []): ProbeCacheStore & { data: ProbeCache; holt: Set<string> } {
  const data = { ...initial };
  const known = new Set(holt);
  return {
    data,
    holt: known,
    get: async (origin) => data[origin],
    set: async (origin, entry) => {
      data[origin] = entry;
    },
    wasHolt: async (origin) => known.has(origin),
    markHolt: async (origin) => void known.add(origin),
  };
}

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    tabUrl: `${VITE}/checkout?x=1`,
    settings: { serverMode: "auto", serverUrl: FALLBACK },
    probe: vi.fn(async () => status),
    cache: memoryCache(),
    now: 1_000_000,
    ...overrides,
  };
}

describe("resolveServer", () => {
  it("uses the tab's origin when it answers as holt, and hands over the status it got", async () => {
    const args = input();
    expect(await resolveServer(args)).toEqual({ serverUrl: VITE, source: "tab", status });
    expect(args.probe).toHaveBeenCalledWith(VITE);
  });

  it("falls back to the configured URL when the tab's origin is not holt", async () => {
    const args = input({ probe: vi.fn(async () => null) });
    expect(await resolveServer(args)).toEqual({ serverUrl: FALLBACK, source: "fallback" });
  });

  it("treats a probe that throws as 'not holt'", async () => {
    const args = input({ probe: vi.fn(async () => Promise.reject(new Error("boom"))) });
    expect(await resolveServer(args)).toEqual({ serverUrl: FALLBACK, source: "fallback" });
    expect((args.cache as ReturnType<typeof memoryCache>).data[VITE]?.ok).toBe(false);
  });

  it("accepts a holt that wants a token (probe says true) without a status", async () => {
    expect(await resolveServer(input({ probe: vi.fn(async () => true as const) }))).toEqual({ serverUrl: VITE, source: "tab" });
  });

  it("fixed mode never probes", async () => {
    const args = input({ settings: { serverMode: "fixed", serverUrl: FALLBACK } });
    expect(await resolveServer(args)).toEqual({ serverUrl: FALLBACK, source: "fixed" });
    expect(args.probe).not.toHaveBeenCalled();
  });

  it.each([
    ["no URL (tab not readable)", undefined],
    ["a site on the internet", "https://example.com/"],
    ["a LAN address", "http://192.168.1.20:5173/"],
    ["a name that only starts like localhost", "http://localhost.example.com/"],
    ["chrome:// pages", "chrome://extensions/"],
    ["the extension's own pages", "chrome-extension://abc/sidepanel.html"],
    ["file://", "file:///Users/me/index.html"],
    ["junk", "not a url"],
  ])("never probes %s", async (_what, tabUrl) => {
    const args = input({ tabUrl });
    expect(await resolveServer(args)).toEqual({ serverUrl: FALLBACK, source: "fallback" });
    expect(args.probe).not.toHaveBeenCalled();
  });

  it("caches a positive result for a while, then probes again", async () => {
    const cache = memoryCache();
    const probe = vi.fn(async () => status);
    await resolveServer(input({ cache, probe, now: 0 }));
    expect(await resolveServer(input({ cache, probe, now: PROBE_TTL_OK_MS - 1 }))).toEqual({ serverUrl: VITE, source: "tab" });
    expect(probe).toHaveBeenCalledTimes(1);
    await resolveServer(input({ cache, probe, now: PROBE_TTL_OK_MS }));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("caches a negative result for a shorter while", async () => {
    const cache = memoryCache();
    const probe = vi.fn(async () => null);
    await resolveServer(input({ cache, probe, now: 0 }));
    expect(await resolveServer(input({ cache, probe, now: PROBE_TTL_FAILED_MS - 1 }))).toEqual({ serverUrl: FALLBACK, source: "fallback" });
    expect(probe).toHaveBeenCalledTimes(1);
    await resolveServer(input({ cache, probe, now: PROBE_TTL_FAILED_MS }));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("caches per origin", async () => {
    const cache = memoryCache({ [VITE]: { ok: true, at: 0 } });
    const probe = vi.fn(async () => null);
    expect((await resolveServer(input({ cache, probe, now: 1, tabUrl: "http://127.0.0.1:3000/" }))).source).toBe("fallback");
    expect(probe).toHaveBeenCalledWith("http://127.0.0.1:3000");
    expect((await resolveServer(input({ cache, probe, now: 2 }))).source).toBe("tab");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("remembers every origin that answered as holt", async () => {
    const cache = memoryCache();
    await resolveServer(input({ cache }));
    expect([...cache.holt]).toEqual([VITE]);
    await resolveServer(input({ cache, tabUrl: "http://127.0.0.1:3000/", probe: vi.fn(async () => null) }));
    expect([...cache.holt]).toEqual([VITE]);
  });

  describe("an origin that has been holt never falls back", () => {
    it("a failed probe (timeout, restart) is an error naming that server, not the fallback", async () => {
      const cache = memoryCache({}, [VITE]);
      const error = await resolveServer(input({ cache, probe: vi.fn(async () => null) })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HoltNotAnsweringError);
      expect((error as HoltNotAnsweringError).serverUrl).toBe(VITE);
      expect((error as Error).message).toBe(`holt on ${VITE} isn't answering (dev server restarting?). Try again in a moment.`);
    });

    it("so is a fresh negative cache entry, and a probe that throws", async () => {
      await expect(resolveServer(input({ cache: memoryCache({ [VITE]: { ok: false, at: 1_000_000 } }, [VITE]) }))).rejects.toBeInstanceOf(HoltNotAnsweringError);
      await expect(resolveServer(input({ cache: memoryCache({}, [VITE]), probe: vi.fn(async () => Promise.reject(new Error("boom"))) }))).rejects.toBeInstanceOf(HoltNotAnsweringError);
    });

    it("once it answers again, it is used again", async () => {
      const cache = memoryCache({}, [VITE]);
      expect(await resolveServer(input({ cache }))).toEqual({ serverUrl: VITE, source: "tab", status });
    });

    it("only that origin: others still fall back, and fixed mode is unaffected", async () => {
      const cache = memoryCache({}, [VITE]);
      expect(await resolveServer(input({ cache, tabUrl: "http://localhost:3000/", probe: vi.fn(async () => null) }))).toEqual({ serverUrl: FALLBACK, source: "fallback" });
      expect(await resolveServer(input({ cache, probe: vi.fn(async () => null), settings: { serverMode: "fixed", serverUrl: FALLBACK } }))).toEqual({
        serverUrl: FALLBACK,
        source: "fixed",
      });
    });
  });

  it("does not trust a cache entry from the future (clock changed)", async () => {
    const cache = memoryCache({ [VITE]: { ok: false, at: 10_000 } });
    const probe = vi.fn(async () => status);
    expect((await resolveServer(input({ cache, probe, now: 0 }))).source).toBe("tab");
  });
});

describe("probeableOrigin / isLocalPage", () => {
  it("returns the bare origin of http pages on the hosts our host_permissions cover", () => {
    expect(probeableOrigin("http://localhost:5173/a/b?c#d")).toBe("http://localhost:5173");
    expect(probeableOrigin("http://127.0.0.1:4848/")).toBe("http://127.0.0.1:4848");
    expect(probeableOrigin("http://localhost/")).toBe("http://localhost");
    expect(probeableOrigin("http://user:pw@localhost:3000/")).toBe("http://localhost:3000");
  });
  it("not other loopback spellings: the manifest has no host permission for them, so the worker couldn't read the tab or fetch", () => {
    for (const url of ["https://app.localhost:8443/", "http://app.localhost:5173/", "http://[::1]:3000/", "http://127.0.0.2:5173/", "https://localhost:5173/", "https://127.0.0.1:4848/"]) {
      expect(probeableOrigin(url), url).toBeNull();
    }
  });
  it("judges the host after URL normalisation, the way Chrome would connect", () => {
    // Other spellings of 127.0.0.1 normalise to it, so they are local.
    expect(probeableOrigin("http://127.1:5173/")).toBe("http://127.0.0.1:5173");
    expect(probeableOrigin("http://0x7f.0.0.1:5173/")).toBe("http://127.0.0.1:5173");
    expect(probeableOrigin("http://LOCALHOST:5173/")).toBe("http://localhost:5173");
    // Spellings that are not plainly loopback are never probed.
    for (const url of [
      "http://localhost.:5173/",
      "http://[::ffff:127.0.0.1]:5173/",
      "http://0.0.0.0:5173/",
      "http://127.0.0.1.nip.io:5173/",
      "http://localhost@evil.example/",
      "ws://localhost:5173/",
    ]) {
      expect(probeableOrigin(url), url).toBeNull();
    }
  });
  it("says whether a page is on this machine", () => {
    expect(isLocalPage("http://localhost:3000/")).toBe(true);
    expect(isLocalPage("https://example.com/")).toBe(false);
    expect(isLocalPage(undefined)).toBe(false);
  });
});

describe("addHoltOrigin", () => {
  it("adds once", () => {
    expect(addHoltOrigin([], VITE)).toEqual([VITE]);
    expect(addHoltOrigin([VITE], VITE)).toEqual([VITE]);
    expect(addHoltOrigin([VITE], FALLBACK)).toEqual([VITE, FALLBACK]);
  });
});

describe("updateProbeCache", () => {
  it("sets the entry and drops stale ones", () => {
    const cache: ProbeCache = {
      "http://localhost:1": { ok: true, at: 0 },
      "http://localhost:2": { ok: false, at: 14_000 },
      "http://localhost:3": { ok: true, at: 9_000 },
    };
    expect(updateProbeCache(cache, "http://localhost:4", { ok: false, at: 20_000 }, 20_000)).toEqual({
      "http://localhost:3": { ok: true, at: 9_000 },
      "http://localhost:4": { ok: false, at: 20_000 },
    });
  });
});
