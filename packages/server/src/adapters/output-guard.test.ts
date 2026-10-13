import path from "node:path";
import { describe, expect, it } from "vitest";
import { requestTouchesOutputDir, type OutputGuardOptions } from "./output-guard.js";

const root = path.resolve("/work/app");
const options: OutputGuardOptions = {
  root,
  outputDir: path.join(root, "qa"),
  publicDir: path.join(root, "public"),
  base: "/",
};
const blocked = (url: string, opts: Partial<OutputGuardOptions> = {}) =>
  requestTouchesOutputDir(url, { ...options, ...opts });

describe("requestTouchesOutputDir", () => {
  it.each([
    "/qa",
    "/qa/",
    "/qa/2026-10-13-075200/notes.md",
    "/qa/2026-10-13-075200/001-screenshot.png?raw",
    "/qa/x.png#frag",
    "//qa/x.png",
    "/./qa/x.png",
    "/src/../qa/x.png",
    "/src/%2e%2e/qa/x.png",
    "/%71a/x.png", // %71 = "q"
    "/qa%2Fx.png",
    "/src%2F..%2Fqa%2Fx.png",
    "/QA/x.png", // case-insensitive file systems
    "/qa\\x.png",
    "/src\\..\\qa\\x.png",
    `/@fs${path.join(root, "qa/x.png")}`,
    `/@fs/${path.join(root, "qa/x.png")}`,
    "/@id/qa/x.png",
    "http://localhost:5173/qa/x.png",
    "/%E0%A4%A", // malformed escape: refused
    "/qa%00.png",
  ])("blocks %s", (url) => {
    expect(blocked(url)).toBe(true);
  });

  it.each(["/", "/index.html", "/src/main.ts", "/qa-notes.html", "/qaa/x.png", "/src/qa/x.ts", "/@vite/client", "/@fs/etc/hosts", "/?qa"])(
    "allows %s",
    (url) => {
      expect(blocked(url)).toBe(false);
    },
  );

  it("handles a non-root base", () => {
    expect(blocked("/app/qa/x.png", { base: "/app/" })).toBe(true);
    expect(blocked("/app/index.html", { base: "/app/" })).toBe(false);
  });

  it("handles an output dir inside publicDir (served at /)", () => {
    const outputDir = path.join(root, "public/qa");
    expect(blocked("/qa/x.png", { outputDir })).toBe(true);
    expect(blocked("/public/qa/x.png", { outputDir })).toBe(true);
    expect(blocked("/logo.svg", { outputDir })).toBe(false);
  });

  it("only blocks /@fs paths for an output dir outside the root", () => {
    const outputDir = path.resolve("/elsewhere/qa");
    expect(blocked("/qa/x.png", { outputDir })).toBe(false);
    expect(blocked(`/@fs${path.join(outputDir, "x.png")}`, { outputDir })).toBe(true);
  });
});
