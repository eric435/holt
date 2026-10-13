import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PACKAGE_JSON_BYTES, MAX_PROJECT_NAME_LENGTH } from "./defaults.js";
import { describeProject, readPackageJson, resolveProject, sanitizeProjectName } from "./project.js";

const ROOT = path.join(path.sep, "work", "acme-web");
const pkg = (value: unknown) => JSON.stringify(value);

describe("resolveProject", () => {
  it("prefers projectName from config over package.json and the directory", () => {
    expect(resolveProject({ root: ROOT, projectName: "Checkout", packageJson: pkg({ name: "acme" }) })).toEqual({
      project: { name: "Checkout", source: "config" },
    });
  });

  it("trims a configured name", () => {
    expect(resolveProject({ root: ROOT, projectName: "  Checkout ", packageJson: null }).project.name).toBe("Checkout");
  });

  it("uses the package.json name, scoped names included", () => {
    expect(resolveProject({ root: ROOT, packageJson: pkg({ name: "acme" }) })).toEqual({
      project: { name: "acme", source: "package.json" },
    });
    expect(resolveProject({ root: ROOT, packageJson: pkg({ name: "@acme/web" }) }).project.name).toBe("@acme/web");
  });

  it("accepts a package.json with a byte-order mark", () => {
    expect(resolveProject({ root: ROOT, packageJson: `﻿${pkg({ name: "acme" })}` }).project).toEqual({
      name: "acme",
      source: "package.json",
    });
  });

  it("falls back to the directory name when there is no package.json", () => {
    expect(resolveProject({ root: ROOT, packageJson: null })).toEqual({
      project: { name: "acme-web", source: "directory" },
    });
  });

  it.each([
    ["no name field", pkg({ version: "1.0.0" })],
    ["a non-string name", pkg({ name: 42 })],
    ["an empty name", pkg({ name: "" })],
    ["a whitespace name", pkg({ name: "   " })],
    ["a name of only control characters", pkg({ name: "\u0000\u001b" })],
    ["a JSON array", pkg(["acme"])],
    ["JSON null", "null"],
    ["a JSON string", pkg("acme")],
  ])("falls back to the directory name for %s, without a warning", (_label, packageJson) => {
    expect(resolveProject({ root: ROOT, packageJson })).toEqual({
      project: { name: "acme-web", source: "directory" },
    });
  });

  it("falls back to the directory name for invalid JSON, with a warning naming the file", () => {
    const result = resolveProject({ root: ROOT, packageJson: "{ name: acme" });
    expect(result.project).toEqual({ name: "acme-web", source: "directory" });
    expect(result.warning).toContain(path.join(ROOT, "package.json"));
    expect(result.warning).toContain("projectName");
  });

  it("never returns an empty name, even for the filesystem root", () => {
    const { project } = resolveProject({ root: path.parse(process.cwd()).root, packageJson: null });
    expect(project.source).toBe("directory");
    expect(project.name).not.toBe("");
  });

  it("sanitizes names from package.json and the directory", () => {
    expect(resolveProject({ root: ROOT, packageJson: pkg({ name: "ac\u001b[31mme\n" }) }).project.name).toBe(
      "ac[31mme",
    );
    expect(resolveProject({ root: path.join(ROOT, "x‮y"), packageJson: null }).project.name).toBe("xy");
  });
});

describe("sanitizeProjectName", () => {
  it("strips C0/C1 controls, DEL, zero-width and bidi characters, then trims", () => {
    expect(sanitizeProjectName(" a\u0000b\u0007c\u007fd\u0085e​f‮g⁦h﻿ ")).toBe("abcdefgh");
  });

  it(`truncates to ${MAX_PROJECT_NAME_LENGTH} UTF-16 code units`, () => {
    expect(sanitizeProjectName("a".repeat(150))).toBe("a".repeat(MAX_PROJECT_NAME_LENGTH));
  });

  it("does not leave half a surrogate pair at the cut", () => {
    const name = sanitizeProjectName(`${"a".repeat(MAX_PROJECT_NAME_LENGTH - 1)}😀tail`);
    expect(name).toBe("a".repeat(MAX_PROJECT_NAME_LENGTH - 1));
  });

  it("does not end on whitespace after truncating", () => {
    expect(sanitizeProjectName(`${"a".repeat(MAX_PROJECT_NAME_LENGTH - 1)} b`)).toBe(
      "a".repeat(MAX_PROJECT_NAME_LENGTH - 1),
    );
  });
});

describe("describeProject", () => {
  it("says where the name came from unless it was configured", () => {
    expect(describeProject({ name: "acme", source: "config" })).toBe("acme");
    expect(describeProject({ name: "acme", source: "package.json" })).toBe("acme (from package.json)");
    expect(describeProject({ name: "acme", source: "directory" })).toBe("acme (directory name)");
  });
});

describe("readPackageJson", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nitpick-project-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the file contents", async () => {
    await writeFile(path.join(dir, "package.json"), pkg({ name: "acme" }));
    expect(await readPackageJson(dir)).toBe(pkg({ name: "acme" }));
  });

  it("returns null when the file is missing", async () => {
    expect(await readPackageJson(dir)).toBeNull();
  });

  it("returns null when package.json is a directory", async () => {
    await mkdir(path.join(dir, "package.json"));
    expect(await readPackageJson(dir)).toBeNull();
  });

  it("reads a file exactly at the size cap and skips one byte over", async () => {
    const atCap = `"${"x".repeat(MAX_PACKAGE_JSON_BYTES - 2)}"`;
    await writeFile(path.join(dir, "package.json"), atCap);
    expect((await readPackageJson(dir))?.length).toBe(MAX_PACKAGE_JSON_BYTES);

    await writeFile(path.join(dir, "package.json"), `${atCap} `);
    expect(await readPackageJson(dir)).toBeNull();
  });

  it("does not walk up to a parent package.json", async () => {
    await writeFile(path.join(dir, "package.json"), pkg({ name: "parent" }));
    const child = path.join(dir, "child");
    await mkdir(child);
    expect(await readPackageJson(child)).toBeNull();
  });
});
