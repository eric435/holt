import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../config/types.js";
import { checkOriginAndHost, isAllowedHost, isAllowedOrigin, isLoopbackAddress } from "./cors.js";
import { HttpError } from "./errors.js";

const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

describe("isAllowedOrigin", () => {
  const policy = (allowedOrigins: string[] = [], allowedExtensionIds: string[] = []) => ({
    allowedOrigins,
    allowedExtensionIds,
  });

  it("allows any well-formed chrome-extension origin by default", () => {
    expect(isAllowedOrigin(EXT, policy())).toBe(true);
  });

  it("rejects web pages, null, and malformed extension origins", () => {
    expect(isAllowedOrigin("https://evil.example", policy())).toBe(false);
    expect(isAllowedOrigin("null", policy())).toBe(false);
    expect(isAllowedOrigin("chrome-extension://short", policy())).toBe(false);
    expect(isAllowedOrigin(`${EXT}.evil.example`, policy())).toBe(false);
    expect(isAllowedOrigin(`${EXT}/`, policy())).toBe(false);
    expect(isAllowedOrigin("moz-extension://abcdefghijklmnopabcdefghijklmnop", policy())).toBe(false);
  });

  it("allows configured web origins exactly", () => {
    expect(isAllowedOrigin("http://localhost:3000", policy(["http://localhost:3000"]))).toBe(true);
    expect(isAllowedOrigin("http://localhost:3001", policy(["http://localhost:3000"]))).toBe(false);
  });

  it("restricts extensions to allowedExtensionIds when set", () => {
    const pinned = policy([], ["abcdefghijklmnopabcdefghijklmnop"]);
    expect(isAllowedOrigin(EXT, pinned)).toBe(true);
    expect(isAllowedOrigin("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba", pinned)).toBe(false);
    // Web origins are unaffected by the extension list.
    expect(isAllowedOrigin("http://localhost:3000", policy(["http://localhost:3000"], ["abcdefghijklmnopabcdefghijklmnop"]))).toBe(true);
  });
});

describe("isLoopbackAddress", () => {
  it.each(["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"])("%s is loopback", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(true);
  });
  it.each(["192.168.1.5", "10.0.0.1", "::ffff:192.168.1.5", "fe80::1", "", undefined])("%s is not", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });
});

describe("isAllowedHost (DNS rebinding defense)", () => {
  it.each(["127.0.0.1:4848", "localhost:5173", "LOCALHOST", "app.localhost:3000", "[::1]:4848", "127.0.0.1"])(
    "allows %s",
    (host) => {
      expect(isAllowedHost(host, "127.0.0.1")).toBe(true);
    },
  );

  it.each(["evil.example", "evil.example:4848", "192.168.1.5:4848", "localhost.evil.example", "", undefined])(
    "rejects %s",
    (host) => {
      expect(isAllowedHost(host, "127.0.0.1")).toBe(false);
    },
  );

  it("allows the explicitly configured host, but never a wildcard", () => {
    expect(isAllowedHost("192.168.1.5:4848", "192.168.1.5")).toBe(true);
    expect(isAllowedHost("0.0.0.0:4848", "0.0.0.0")).toBe(false);
    expect(isAllowedHost("evil.example", "0.0.0.0")).toBe(false);
  });
});

describe("checkOriginAndHost", () => {
  const config = (token: string | null = null) =>
    ({ host: "127.0.0.1", allowedOrigins: [], allowedExtensionIds: [], token }) as unknown as ResolvedConfig;
  const fakeReq = (headers: Record<string, string>, remoteAddress: string) =>
    ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

  it("allows no-Origin requests from loopback (curl)", () => {
    expect(checkOriginAndHost(fakeReq({ host: "127.0.0.1:4848" }, "127.0.0.1"), config())).toEqual({ origin: null });
  });

  it("rejects no-Origin requests that carry Sec-Fetch-* headers (same-origin browser requests)", () => {
    for (const header of ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]) {
      expect(() =>
        checkOriginAndHost(fakeReq({ host: "127.0.0.1:4848", [header]: "same-origin" }, "127.0.0.1"), config()),
      ).toThrow(/Browser requests must come from the holt extension/);
    }
  });

  it("allows Sec-Fetch-Site: none without an Origin (how Chrome sends the extension's own GETs)", () => {
    // Observed from the real extension (e2e): GET /status arrives with no
    // Origin, Sec-Fetch-Site: none, Sec-Fetch-Mode: cors.
    const req = fakeReq(
      { host: "127.0.0.1:4848", "sec-fetch-site": "none", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
      "127.0.0.1",
    );
    expect(checkOriginAndHost(req, config())).toEqual({ origin: null });
  });

  it.each(["same-origin", "same-site", "cross-site"])("rejects Sec-Fetch-Site: %s without an Origin", (site) => {
    const req = fakeReq({ host: "127.0.0.1:4848", "sec-fetch-site": site, "sec-fetch-mode": "cors" }, "127.0.0.1");
    expect(() => checkOriginAndHost(req, config())).toThrow(/Browser requests/);
  });

  it("still allows an extension request that carries Sec-Fetch-* headers alongside its Origin", () => {
    const req = fakeReq({ host: "127.0.0.1:4848", origin: EXT, "sec-fetch-site": "cross-site" }, "127.0.0.1");
    expect(checkOriginAndHost(req, config())).toEqual({ origin: EXT });
  });

  it("returns the origin to echo for an extension", () => {
    expect(checkOriginAndHost(fakeReq({ host: "127.0.0.1:4848", origin: EXT }, "127.0.0.1"), config())).toEqual({
      origin: EXT,
    });
  });

  it("rejects a bad Host even with a good Origin", () => {
    expect(() => checkOriginAndHost(fakeReq({ host: "evil.example", origin: EXT }, "127.0.0.1"), config())).toThrow(
      /Host header/,
    );
  });

  it("rejects every request from another machine when no token is configured, whatever its headers", () => {
    const forged = fakeReq({ host: "127.0.0.1:4848", origin: EXT }, "192.168.1.9");
    expect(() => checkOriginAndHost(forged, config())).toThrow(HttpError);
    expect(() => checkOriginAndHost(forged, config())).toThrow(/other machines/);
    expect(() => checkOriginAndHost(fakeReq({ host: "127.0.0.1:4848" }, "192.168.1.9"), config())).toThrow(/other machines/);
  });

  it("lets a remote request through to the token check when a token is configured", () => {
    const req = fakeReq({ host: "127.0.0.1:4848", origin: EXT }, "192.168.1.9");
    expect(checkOriginAndHost(req, config("secret"))).toEqual({ origin: EXT });
    // ...but a remote request still needs an Origin.
    expect(() => checkOriginAndHost(fakeReq({ host: "127.0.0.1:4848" }, "192.168.1.9"), config("secret"))).toThrow(
      /only accepted from this machine/,
    );
  });

  it("refuses a LAN client's real Host header under the default host, even with a token (Vite --host)", () => {
    // The Vite plugin leaves `host` at its default (Vite owns the socket),
    // so a machine reaching `vite --host` at 192.168.1.5:5173 sends that
    // Host and fails step 1 whatever its token. Under Vite, holt's API is
    // loopback-only; remote use goes through the standalone server.
    const req = fakeReq({ host: "192.168.1.5:5173", origin: EXT }, "192.168.1.9");
    expect(() => checkOriginAndHost(req, config("secret"))).toThrow(HttpError);
    expect(() => checkOriginAndHost(req, config("secret"))).toThrow(/Host header is not a loopback host/);
  });
});
