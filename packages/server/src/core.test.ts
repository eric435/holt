import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHolt } from "./core.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "holt-core-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createHolt startup logging", () => {
  it("logs nothing about access with the defaults", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await createHolt({ cwd: dir, logger });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns about every allowed origin, every allowed extension ID, and a non-default host", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await createHolt({
      cwd: dir,
      logger,
      overrides: {
        allowedOrigins: ["http://localhost:3000", "https://app.test"],
        allowedExtensionIds: ["abcdefghijklmnopabcdefghijklmnop", "ponmlkjihgfedcbaponmlkjihgfedcba"],
        host: "localhost",
      },
    });
    const warnings = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warnings).toContain("http://localhost:3000");
    expect(warnings).toContain("https://app.test");
    expect(warnings).toContain("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(warnings).toContain("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba");
    expect(warnings).toMatch(/host is set to "localhost"/);
    expect(logger.warn).toHaveBeenCalledTimes(5);
  });
});

describe("createHolt project identity", () => {
  it("resolves the project from <cwd>/package.json once, at startup", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "@acme/web" }));
    const holt = await createHolt({ cwd: dir, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    expect(holt.config.project).toEqual({ name: "@acme/web", source: "package.json" });
  });

  it("starts with the directory name and one warning when package.json is broken", async () => {
    await writeFile(path.join(dir, "package.json"), "{");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const holt = await createHolt({ cwd: dir, logger });
    expect(holt.config.project).toEqual({ name: path.basename(dir), source: "directory" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toMatch(/package\.json is not valid JSON/);
  });
});
