import path from "node:path";
import { describe, expect, it } from "vitest";
import { requestTouchesProtectedPath, type ProtectedPathOptions } from "./output-guard.js";

const root = path.resolve("/work/app");
const options: ProtectedPathOptions = {
  root,
  outputDir: path.join(root, "qa"),
  publicDir: path.join(root, "public"),
  base: "/",
};
/** The /@fs URL Vite itself builds for an absolute path: "/@fs/work/app/x" or "/@fs/D:/work/app/x". */
const fsUrl = (file: string) => path.posix.join("/@fs/", file.replace(/\\/g, "/"));
const blocked = (url: string, opts: Partial<ProtectedPathOptions> = {}) =>
  requestTouchesProtectedPath(url, { ...options, ...opts });

describe("requestTouchesProtectedPath: output dir", () => {
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
    fsUrl(path.join(root, "qa/x.png")),
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
    expect(blocked(fsUrl(path.join(outputDir, "x.png")), { outputDir })).toBe(true);
  });
});

describe("requestTouchesProtectedPath: config file", () => {
  const configFile = path.join(root, "holt.config.json");
  const withConfig = (url: string, opts: Partial<ProtectedPathOptions> = {}) =>
    blocked(url, { protectedFiles: [configFile], ...opts });

  it.each([
    "/holt.config.json",
    "/holt.config.json?import",
    "/holt.config.json?raw",
    "/holt%2Econfig.json",
    "/%68olt.config.json", // %68 = "h"
    "/HOLT.CONFIG.JSON",
    "/Holt.Config.Json",
    "//holt.config.json",
    "/src/../holt.config.json",
    "/src%2F..%2Fholt.config.json",
    "/src\\..\\holt.config.json",
    fsUrl(configFile),
    `/@fs/${configFile}`,
    "/@id/holt.config.json",
    "http://localhost:5173/holt.config.json",
  ])("blocks %s", (url) => {
    expect(withConfig(url)).toBe(true);
  });

  it.each(["/holt.config.json.html", "/holt.config.jsonx", "/src/holt.config.json", "/holt.config.ts", "/public/x.json"])(
    "allows %s (exact file, not a prefix)",
    (url) => {
      expect(withConfig(url)).toBe(false);
    },
  );

  it("handles a non-root base", () => {
    expect(withConfig("/app/holt.config.json", { base: "/app/" })).toBe(true);
    expect(withConfig("/app/index.html", { base: "/app/" })).toBe(false);
  });

  it("protects a config file outside the root through /@fs only", () => {
    const elsewhere = path.resolve("/elsewhere/holt.json");
    expect(withConfig(fsUrl(elsewhere), { protectedFiles: [elsewhere] })).toBe(true);
    expect(withConfig("/holt.json", { protectedFiles: [elsewhere] })).toBe(false);
  });

  it("protects every listed file (the loaded one and the default location)", () => {
    const custom = path.join(root, "config/holt.json");
    const both = { protectedFiles: [configFile, custom] };
    expect(withConfig("/holt.config.json", both)).toBe(true);
    expect(withConfig("/config/holt.json", both)).toBe(true);
    expect(withConfig("/config/other.json", both)).toBe(false);
  });

  it("protects nothing extra without protectedFiles", () => {
    expect(blocked("/holt.config.json")).toBe(false);
  });
});

/**
 * Windows rules, checked on any OS through path.win32. The bug these guard
 * against: path.resolve("/C:/proj/qa/x.png") on win32 is a path on the
 * current drive (`\C:\proj\...` or `D:\C:\...`), never inside `C:\proj\qa`.
 */
describe("requestTouchesProtectedPath: win32", () => {
  const winRoot = "C:\\proj";
  const win: ProtectedPathOptions = {
    root: winRoot,
    outputDir: "C:\\proj\\qa",
    protectedFiles: ["C:\\proj\\holt.config.json"],
    publicDir: "C:\\proj\\public",
    base: "/",
    pathApi: path.win32,
  };
  const winBlocked = (url: string, opts: Partial<ProtectedPathOptions> = {}) =>
    requestTouchesProtectedPath(url, { ...win, ...opts });

  it.each([
    "/qa/x.png",
    "/QA/x.png",
    "/@fs/C:/proj/qa/x.png",
    "/@fs/c:/proj/qa/x.png",
    "/@fs/C:/PROJ/QA/x.png",
    "/@fs/C:\\proj\\qa\\x.png",
    "/@fs/C:%5Cproj%5Cqa%5Cx.png",
    "/@fs/C%3A/proj/qa/x.png",
    "/%40fs/C:/proj/qa/x.png",
    "/@fs//C:/proj/qa/x.png",
    "/@fs/C:/proj/src/../qa/x.png",
    "/@id/C:/proj/qa/x.png",
    "/qa./x.png", // Windows ignores trailing dots and spaces in names
    "/qa%20/x.png",
    "/qa::$DATA/x.png",
  ])("blocks %s", (url) => {
    expect(winBlocked(url)).toBe(true);
  });

  it.each([
    "/holt.config.json",
    "/HOLT.config.json",
    "/holt%2Econfig.json",
    "/holt.config.json.",
    "/holt.config.json::$DATA",
    "/@fs/C:/proj/holt.config.json",
    "/@fs/c:/proj/holt.config.json",
    "/@fs/C:%5Cproj%5Cholt.config.json",
    "/@id/C:/proj/holt.config.json",
  ])("blocks the config file at %s", (url) => {
    expect(winBlocked(url)).toBe(true);
  });

  it.each(["/", "/src/main.ts", "/qa-notes.html", "/@fs/C:/proj/src/main.ts", "/@fs/D:/proj/qa/x.png", "/@fs/C:/other/qa/x.png", "/@fs/C:/proj/holt.config.json.html"])(
    "allows %s",
    (url) => {
      expect(winBlocked(url)).toBe(false);
    },
  );

  it("blocks /@fs paths into an output dir on another drive", () => {
    const opts = { outputDir: "D:\\notes\\qa" };
    expect(winBlocked("/@fs/D:/notes/qa/x.png", opts)).toBe(true);
    expect(winBlocked("/@fs/d:/Notes/QA/x.png", opts)).toBe(true);
    expect(winBlocked("/qa/x.png", opts)).toBe(false);
  });
});
