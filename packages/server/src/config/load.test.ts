import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MAX_UPLOAD_BYTES, DEFAULT_PORT } from "@nitpick/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./load.js";
import { ConfigError } from "./validate.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "nitpick-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeConfig = (content: unknown, name = "nitpick.config.json") =>
  writeFile(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));

describe("loadConfig", () => {
  it("returns defaults when there is no config file", async () => {
    const { config, warnings } = await loadConfig(dir);
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      root: dir,
      outputDir: path.join(dir, "qa"),
      port: DEFAULT_PORT,
      host: "127.0.0.1",
      token: null,
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      sessionTitle: "QA session",
      allowedOrigins: [],
      configFile: null,
    });
  });

  it("reads nitpick.config.json and resolves outputDir against the root", async () => {
    await writeConfig({ outputDir: "docs/qa", port: 5000, token: "t" });
    const { config } = await loadConfig(dir);
    expect(config.outputDir).toBe(path.join(dir, "docs/qa"));
    expect(config.port).toBe(5000);
    expect(config.token).toBe("t");
    expect(config.host).toBe("127.0.0.1"); // default kept
    expect(config.configFile).toBe(path.join(dir, "nitpick.config.json"));
  });

  it("lets overrides (CLI flags) win over the file, which wins over defaults", async () => {
    await writeConfig({ port: 5000, outputDir: "from-file", sessionTitle: "File title" });
    const { config } = await loadConfig(dir, { port: 6000, outputDir: "from-cli" });
    expect(config.port).toBe(6000);
    expect(config.outputDir).toBe(path.join(dir, "from-cli"));
    expect(config.sessionTitle).toBe("File title");
    expect(config.maxUploadBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });

  it("keeps an absolute outputDir as is", async () => {
    const abs = path.join(dir, "elsewhere");
    const { config } = await loadConfig(dir, { outputDir: abs });
    expect(config.outputDir).toBe(abs);
  });

  it("returns unknown-key warnings from both the file and overrides", async () => {
    await writeConfig({ ouputDir: "x" });
    const { warnings } = await loadConfig(dir, { bogus: true } as never, { overridesSource: "flags" });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"ouputDir"');
    expect(warnings[1]).toMatch(/^flags: unknown key "bogus"/);
  });

  it("uses an explicit config file path", async () => {
    await writeConfig({ port: 7000 }, "custom.json");
    const { config } = await loadConfig(dir, {}, { configFile: "custom.json" });
    expect(config.port).toBe(7000);
    expect(config.configFile).toBe(path.join(dir, "custom.json"));
  });

  it("fails if an explicit config file is missing", async () => {
    await expect(loadConfig(dir, {}, { configFile: "missing.json" })).rejects.toThrow(/Config file not found/);
  });

  it("fails on invalid JSON with the file name", async () => {
    await writeConfig("{ port: 1 }");
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
    await expect(loadConfig(dir)).rejects.toThrow(/nitpick\.config\.json is not valid JSON/);
  });

  it("fails on invalid values in the file or in overrides", async () => {
    await writeConfig({ port: "nope" });
    await expect(loadConfig(dir)).rejects.toThrow(/"port" must be an integer/);
    await rm(path.join(dir, "nitpick.config.json"));
    await expect(loadConfig(dir, { port: -1 }, { overridesSource: "command line flags" })).rejects.toThrow(
      /Invalid config in command line flags/,
    );
  });
});
