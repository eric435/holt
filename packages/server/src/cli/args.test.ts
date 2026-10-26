import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../config/validate.js";
import { CliUsageError, HELP_TEXT, parseCliArgs } from "./args.js";
import { STARTER_CONFIG, writeStarterConfig } from "./init.js";

describe("parseCliArgs", () => {
  it("defaults to serve with no overrides", () => {
    expect(parseCliArgs([])).toEqual({ command: "serve", overrides: {} });
  });

  it("maps flags to config overrides", () => {
    expect(
      parseCliArgs([
        "--port", "5000", "--host", "localhost", "--out", "notes", "--token", "t", "--config", "x.json",
        "--project-name", "@acme/web",
      ]),
    ).toEqual({
      command: "serve",
      overrides: { port: 5000, host: "localhost", outputDir: "notes", token: "t", projectName: "@acme/web" },
      configFile: "x.json",
    });
  });

  it("parses help, version and init", () => {
    expect(parseCliArgs(["--help"])).toEqual({ command: "help" });
    expect(parseCliArgs(["-v"])).toEqual({ command: "version" });
    expect(parseCliArgs(["init"])).toEqual({ command: "init", force: false });
    expect(parseCliArgs(["init", "--force"])).toEqual({ command: "init", force: true });
  });

  it.each([
    [["--prot", "1"], /Unknown option/],
    [["--port", "abc"], /--port must be a number/],
    [["serve"], /Unknown command: serve/],
    [["init", "extra"], /Unexpected argument/],
    [["--force"], /only applies to `holt init`/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

describe("HELP_TEXT", () => {
  it("points tokens at HOLT_TOKEN", () => {
    expect(HELP_TEXT).toMatch(/HOLT_TOKEN/);
  });
});

describe("writeStarterConfig", () => {
  it("writes a valid config with $schema, and refuses to overwrite without force", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "holt-init-"));
    try {
      const file = await writeStarterConfig(dir, false);
      const written = JSON.parse(await readFile(file, "utf8")) as unknown;
      expect(written).toEqual(STARTER_CONFIG);
      expect(validateConfig(written, file).warnings).toEqual([]);
      // The file is meant to be committed: no token placeholder (HOLT_TOKEN instead).
      expect(written).not.toHaveProperty("token");

      await expect(writeStarterConfig(dir, false)).rejects.toThrow(/already exists/);
      await writeFile(file, "{}");
      await writeStarterConfig(dir, true);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(STARTER_CONFIG);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
