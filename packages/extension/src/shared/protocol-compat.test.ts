import { PROTOCOL_VERSION } from "@holt/protocol";
import { describe, expect, it } from "vitest";
import { LEGACY_PROTOCOL_VERSION, protocolCompatibility, serverProtocolVersion } from "./protocol-compat.js";

const url = "http://127.0.0.1:4848";
const project = { name: "acme-web", source: "package.json" };

describe("serverProtocolVersion", () => {
  it("reads the server's protocolVersion", () => {
    expect(serverProtocolVersion({ protocolVersion: 3 })).toBe(3);
  });

  it("counts a status without one (servers 0.0.2 and older) as protocol 1", () => {
    expect(LEGACY_PROTOCOL_VERSION).toBe(1);
    expect(serverProtocolVersion({ version: "0.0.2" })).toBe(1);
  });

  it.each([null, "2", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, {}])("counts %j as missing", (protocolVersion) => {
    expect(serverProtocolVersion({ protocolVersion })).toBe(1);
  });
});

describe("protocolCompatibility", () => {
  it("accepts a server that speaks our protocol", () => {
    expect(protocolCompatibility({ protocolVersion: PROTOCOL_VERSION }, url)).toEqual({ ok: true, serverProtocol: PROTOCOL_VERSION });
  });

  it("accepts an old server without protocolVersion while ours is 1", () => {
    expect(protocolCompatibility({ version: "0.0.2", project }, url, 1)).toEqual({ ok: true, serverProtocol: 1 });
  });

  it("says an older server must be updated, naming its project and both ways to update", () => {
    const result = protocolCompatibility({ version: "0.0.2", project }, url, 2);
    expect(result).toEqual({
      ok: false,
      problem: "server-too-old",
      serverProtocol: 1,
      message:
        "The holt server in acme-web is too old for this extension. " +
        "Update it: npm i -D @velvet-thunder/holt@latest (or run npx @velvet-thunder/holt@latest), then restart it.",
    });
  });

  it("says this extension must be updated when the server is newer", () => {
    const result = protocolCompatibility({ protocolVersion: 3, project }, url, 2);
    expect(result).toMatchObject({ ok: false, problem: "extension-too-old", serverProtocol: 3 });
    expect(result.ok === false && result.message).toBe(
      "This holt extension is older than the holt server in acme-web. " +
        "Update it at chrome://extensions (Developer mode, then Update) or wait for Chrome to update it.",
    );
  });

  it("names the server's host when it has no project name", () => {
    const result = protocolCompatibility({ protocolVersion: 1, project: { name: "  " } }, "http://localhost:5173", 2);
    expect(result.ok === false && result.message).toMatch(/^The holt server at localhost:5173 is too old/);
  });
});
