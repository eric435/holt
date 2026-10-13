import { describe, expect, it } from "vitest";
import { ConfigError, validateConfig } from "./validate.js";

const validate = (raw: unknown) => validateConfig(raw, "test.json");

describe("validateConfig", () => {
  it("accepts an empty object and returns only the keys that were set", () => {
    expect(validate({})).toEqual({ config: {}, warnings: [] });
    expect(validate({ port: 1234 }).config).toEqual({ port: 1234 });
  });

  it("accepts a full valid config and ignores $schema", () => {
    const raw = {
      $schema: "./node_modules/nitpick-notes/schema.json",
      outputDir: "notes/qa",
      port: 0,
      host: "127.0.0.1",
      token: "s3cret",
      maxUploadBytes: 1024,
      sessionTitle: "Checkout QA",
      allowedOrigins: ["http://localhost:3000", "https://app.test"],
      allowedExtensionIds: ["abcdefghijklmnopabcdefghijklmnop"],
    };
    const { $schema: _ignored, ...expected } = raw;
    expect(validate(raw)).toEqual({ config: expected, warnings: [] });
  });

  it("accepts token: null", () => {
    expect(validate({ token: null }).config).toEqual({ token: null });
  });

  it("skips undefined values (unset overrides)", () => {
    expect(validate({ port: undefined, host: "localhost" }).config).toEqual({ host: "localhost" });
  });

  it.each([
    ["outputDir", 42, /"outputDir" must be a non-empty string \(got number 42\)/],
    ["outputDir", "  ", /"outputDir" must be a non-empty string/],
    ["port", "4848", /"port" must be an integer from 0 to 65535 \(got string "4848"\)/],
    ["port", 70000, /"port" must be an integer from 0 to 65535 \(got number 70000\)/],
    ["port", 1.5, /"port" must be an integer/],
    ["host", null, /"host" must be a non-empty string \(got null\)/],
    ["token", "", /"token" must be a non-empty string or null/],
    ["token", 123, /"token" must be a non-empty string or null \(got number 123\)/],
    ["maxUploadBytes", -1, /"maxUploadBytes" must be a positive integer/],
    ["maxUploadBytes", "200mb", /"maxUploadBytes" must be a positive integer number of bytes \(got string/],
    ["sessionTitle", [], /"sessionTitle" must be a non-empty string \(got an array\)/],
    ["allowedOrigins", "http://localhost:3000", /"allowedOrigins" must be an array/],
    ["allowedOrigins", ["*"], /must not contain wildcards/],
    ["allowedOrigins", ["http://localhost:3000/"], /exact http\(s\) origins/],
    ["allowedOrigins", ["ftp://example.com"], /exact http\(s\) origins/],
    ["allowedOrigins", ["not a url"], /must contain origins like/],
    ["allowedOrigins", [42], /must contain only strings/],
    ["allowedExtensionIds", "abcdefghijklmnopabcdefghijklmnop", /"allowedExtensionIds" must be an array/],
    ["allowedExtensionIds", ["ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP"], /32 lowercase letters a-p/],
    ["allowedExtensionIds", ["abcdefghijklmnopqrstuvwxyzabcdef"], /32 lowercase letters a-p/],
    ["allowedExtensionIds", ["abc"], /got "abc"/],
    ["allowedExtensionIds", ["chrome-extension://abcdefghijklmnopabcdefghijklmnop"], /32 lowercase letters/],
    ["allowedExtensionIds", [null], /got null/],
  ])("rejects %s = %j", (key, value, message) => {
    expect(() => validate({ [key]: value })).toThrow(ConfigError);
    expect(() => validate({ [key]: value })).toThrow(message);
  });

  it("names the source and reports all errors at once", () => {
    let error: unknown;
    try {
      validate({ port: "x", host: 1 });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    expect(message).toContain("Invalid config in test.json");
    expect(message).toContain('"port"');
    expect(message).toContain('"host"');
  });

  it("warns about unknown keys instead of failing", () => {
    const result = validate({ prot: 1, port: 2 });
    expect(result.config).toEqual({ port: 2 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/unknown key "prot" is ignored/);
  });

  it.each([null, [], "string", 3])("rejects a non-object config (%j)", (raw) => {
    expect(() => validate(raw)).toThrow(/expected a JSON object/);
  });
});
