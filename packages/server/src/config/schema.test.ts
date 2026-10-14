/**
 * schema.json (shipped for editor autocomplete) and validate.ts (what the
 * server actually enforces) are maintained by hand, separately. These tests
 * keep them from drifting: same keys, same defaults, same limits, and no
 * value the editor calls valid that the server then refuses (or the other
 * way round) for the constraints both express.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULTS, MAX_PROJECT_NAME_LENGTH } from "./defaults.js";
import { hasUnsafeChars } from "./project.js";
import { EXTENSION_ID, validateConfig } from "./validate.js";

interface SchemaProperty {
  type?: string | string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: { type?: string; pattern?: string };
}

const schema = JSON.parse(readFileSync(new URL("../../schema.json", import.meta.url), "utf8")) as {
  $id: string;
  additionalProperties: boolean;
  properties: Record<string, SchemaProperty>;
};
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string };

const props = schema.properties;
const configKeys = Object.keys(props).filter((k) => k !== "$schema");

/** The keys validate.ts knows, from its own "unknown key" warning. */
function validatorKeys(): string[] {
  const [warning] = validateConfig({ "not-a-key": 1 }, "probe").warnings;
  const list = /Known keys: (.*)\.$/.exec(warning ?? "")?.[1] ?? "";
  return list.split(", ");
}

const accepts = (key: string, value: unknown): boolean => {
  try {
    validateConfig({ [key]: value }, "schema.test");
    return true;
  } catch {
    return false;
  }
};

describe("schema.json matches validate.ts", () => {
  it("lists exactly the keys the validator knows, and forbids others", () => {
    expect(configKeys.sort()).toEqual(validatorKeys().sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it("documents the same defaults the server uses", () => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      expect(props[key]?.default, key).toEqual(value);
    }
    // projectName is derived (package.json / directory) and has no fixed default.
    expect(props.projectName).not.toHaveProperty("default");
  });

  it("every documented default is accepted by the validator", () => {
    for (const key of configKeys) {
      if (!("default" in props[key]!)) continue;
      expect(accepts(key, props[key]!.default), key).toBe(true);
    }
  });

  it("uses the same port range", () => {
    expect([props.port?.minimum, props.port?.maximum]).toEqual([0, 65535]);
    expect([accepts("port", 0), accepts("port", 65535), accepts("port", -1), accepts("port", 65536)]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("uses the same maxUploadBytes floor", () => {
    expect(props.maxUploadBytes?.minimum).toBe(1);
    expect([accepts("maxUploadBytes", 1), accepts("maxUploadBytes", 0)]).toEqual([true, false]);
  });

  it("uses the same projectName length and character rules", () => {
    expect(props.projectName?.maxLength).toBe(MAX_PROJECT_NAME_LENGTH);
    const pattern = new RegExp(props.projectName?.pattern ?? "");
    // Every character class the server rejects, and some it accepts.
    const samples = ["\u0000", "\u001b", "\u007f", "\u0085", "\u009f", "​", "‏", "‮", "⁦", "﻿", "a", "é", "日本", "👍", "-_. "];
    for (const sample of samples) {
      const name = `x${sample}y`;
      expect(pattern.test(name), JSON.stringify(sample)).toBe(!hasUnsafeChars(name));
      expect(accepts("projectName", name), JSON.stringify(sample)).toBe(!hasUnsafeChars(name));
    }
  });

  it("uses the same extension id pattern", () => {
    expect(props.allowedExtensionIds?.items?.pattern).toBe(EXTENSION_ID.source);
  });

  it("allowedOrigins: values the schema pattern refuses are refused by the server too", () => {
    const pattern = new RegExp(props.allowedOrigins?.items?.pattern ?? "");
    for (const origin of ["*", "http://*.example.com", "ftp://example.com", "http://localhost:3000/app", "localhost:3000"]) {
      expect(pattern.test(origin), origin).toBe(false);
      expect(accepts("allowedOrigins", [origin]), origin).toBe(false);
    }
    for (const origin of ["http://localhost:3000", "https://app.example.com"]) {
      expect(pattern.test(origin), origin).toBe(true);
      expect(accepts("allowedOrigins", [origin]), origin).toBe(true);
    }
  });

  it("token: a string or null, never empty", () => {
    expect(props.token?.type).toEqual(["string", "null"]);
    expect(props.token?.minLength).toBe(1);
    expect([accepts("token", null), accepts("token", "s"), accepts("token", "")]).toEqual([true, true, false]);
  });

  // The npm package "holt" is not this project, so an $id left over from
  // before the rename would make an editor that resolves the schema by $id
  // fetch someone else's file.
  it("$id points at the published package", () => {
    expect(schema.$id).toBe(`https://unpkg.com/${pkg.name}/schema.json`);
  });
});
