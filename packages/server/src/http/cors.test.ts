import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../config/types.js";
import { checkOriginAndHost, isAllowedHost, isAllowedOrigin, isLoopbackAddress } from "./cors.js";
import { HttpError } from "./errors.js";

const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

describe("isAllowedOrigin", () => {
  it("allows any well-formed chrome-extension origin", () => {
    expect(isAllowedOrigin(EXT, [])).toBe(true);
  });

  it("rejects web pages, null, and malformed extension origins", () => {
    expect(isAllowedOrigin("https://evil.example", [])).toBe(false);
    expect(isAllowedOrigin("null", [])).toBe(false);
    expect(isAllowedOrigin("chrome-extension://short", [])).toBe(false);
    expect(isAllowedOrigin(`${EXT}.evil.example`, [])).toBe(false);
    expect(isAllowedOrigin("moz-extension://abcdefghijklmnopabcdefghijklmnop", [])).toBe(false);
  });

  it("allows configured origins exactly", () => {
    expect(isAllowedOrigin("http://localhost:3000", ["http://localhost:3000"])).toBe(true);
    expect(isAllowedOrigin("http://localhost:3001", ["http://localhost:3000"])).toBe(false);
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
  const config = { host: "127.0.0.1", allowedOrigins: [] } as unknown as ResolvedConfig;
  const fakeReq = (headers: Record<string, string>, remoteAddress: string) =>
    ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

  it("allows no-Origin requests from loopback (curl)", () => {
    expect(checkOriginAndHost(fakeReq({ host: "127.0.0.1:4848" }, "127.0.0.1"), config)).toEqual({ origin: null });
  });

  it("rejects no-Origin requests from another machine", () => {
    expect(() => checkOriginAndHost(fakeReq({ host: "127.0.0.1:4848" }, "192.168.1.9"), config)).toThrow(HttpError);
  });

  it("returns the origin to echo for an extension", () => {
    expect(checkOriginAndHost(fakeReq({ host: "127.0.0.1:4848", origin: EXT }, "127.0.0.1"), config)).toEqual({
      origin: EXT,
    });
  });

  it("rejects a bad Host even with a good Origin", () => {
    expect(() => checkOriginAndHost(fakeReq({ host: "evil.example", origin: EXT }, "127.0.0.1"), config)).toThrow(
      /Host header/,
    );
  });
});
