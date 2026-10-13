import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNitpick } from "./core.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "nitpick-core-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createNitpick startup logging", () => {
  it("logs nothing about access with the defaults", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await createNitpick({ cwd: dir, logger });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns about every allowed origin, every allowed extension ID, and a non-default host", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await createNitpick({
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
