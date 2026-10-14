/**
 * Body reading with hard limits, against a fake request stream: the
 * handler tests cover the common cases over real HTTP; these pin down the
 * edges (charset parameters, a lying or missing Content-Length, a client
 * hanging up, an existing file at the target path) without a server.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertContentLengthWithin, mediaType, readJson, streamToFile } from "./body.js";
import { ClientAbortError, HttpError } from "./errors.js";

type FakeRequest = IncomingMessage & { complete: boolean };

/**
 * A request whose body is `chunks`, delivered asynchronously. `abort`
 * makes the client hang up after the chunks instead of finishing (like a
 * real IncomingMessage, `complete` only turns true on a full body).
 */
function fakeRequest(headers: Record<string, string>, chunks: (string | Buffer)[] = [], { abort = false } = {}): FakeRequest {
  const req = new Readable({ read() {} }) as unknown as FakeRequest;
  Object.assign(req, { headers, complete: false, method: "POST", url: "/__holt/x" });
  setImmediate(() => {
    for (const chunk of chunks) (req as unknown as Readable).push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    if (abort) {
      (req as unknown as Readable).destroy();
    } else {
      req.complete = true;
      (req as unknown as Readable).push(null);
    }
  });
  return req;
}

async function httpError(promise: Promise<unknown>): Promise<HttpError> {
  const err = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe("mediaType", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["application/json", "application/json"],
    ["Application/JSON; charset=utf-8", "application/json"],
    ["  image/png  ;foo=bar", "image/png"],
    [";charset=utf-8", undefined],
  ])("%j -> %j", (header, expected) => {
    expect(mediaType(fakeRequest(header === undefined ? {} : { "content-type": header }))).toBe(expected);
  });
});

describe("assertContentLengthWithin", () => {
  it("passes a missing, equal or smaller length, and junk (the byte count still applies)", () => {
    for (const length of [undefined, "10", "0", "abc"]) {
      expect(() => assertContentLengthWithin(fakeRequest(length ? { "content-length": length } : {}), 10)).not.toThrow();
    }
  });
  it("rejects an announced length over the limit with 413", () => {
    expect(() => assertContentLengthWithin(fakeRequest({ "content-length": "11" }), 10)).toThrow(
      expect.objectContaining({ status: 413, code: "payload-too-large" }),
    );
  });
});

describe("readJson", () => {
  const JSON_TYPE = { "content-type": "application/json" };

  it("parses a JSON body, with or without a charset parameter", async () => {
    expect(await readJson(fakeRequest(JSON_TYPE, ['{"a":', "1}"]), 100)).toEqual({ a: 1 });
    expect(await readJson(fakeRequest({ "content-type": "application/json; charset=utf-8" }, ['"x"']), 100)).toBe("x");
  });

  it("decodes UTF-8 split across chunks", async () => {
    const bytes = Buffer.from(JSON.stringify({ note: "naïve café 🎙" }));
    const cut = bytes.indexOf(Buffer.from("🎙")) + 2; // in the middle of the emoji
    expect(await readJson(fakeRequest(JSON_TYPE, [bytes.subarray(0, cut), bytes.subarray(cut)]), 100)).toEqual({
      note: "naïve café 🎙",
    });
  });

  it("returns undefined for an empty body, with or without a content type (bare POST)", async () => {
    expect(await readJson(fakeRequest(JSON_TYPE), 100)).toBeUndefined();
    expect(await readJson(fakeRequest({}), 100)).toBeUndefined();
  });

  it("refuses a non-empty body without a content type (415)", async () => {
    const err = await httpError(readJson(fakeRequest({}, ["{}"]), 100));
    expect(err.status).toBe(415);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp"])(
    "refuses %s (415), before reading anything",
    async (type) => {
      const err = await httpError(readJson(fakeRequest({ "content-type": type }, ["{}"]), 100));
      expect(err.status).toBe(415);
      expect(err.code).toBe("unsupported-media-type");
    },
  );

  it("refuses invalid JSON (400)", async () => {
    const err = await httpError(readJson(fakeRequest(JSON_TYPE, ["{nope"]), 100));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/not valid JSON/);
  });

  it("refuses an announced oversize body (413)", async () => {
    const err = await httpError(readJson(fakeRequest({ ...JSON_TYPE, "content-length": "101" }, []), 100));
    expect(err.status).toBe(413);
  });

  it("refuses a body that turns out bigger than announced, or than the limit without an announcement (413)", async () => {
    const big = `"${"x".repeat(200)}"`;
    expect((await httpError(readJson(fakeRequest({ ...JSON_TYPE, "content-length": "5" }, [big]), 100))).status).toBe(413);
    expect((await httpError(readJson(fakeRequest(JSON_TYPE, ["\"", "x".repeat(60), "x".repeat(60), "\""]), 100))).status).toBe(
      413,
    );
  });

  it("accepts a body of exactly the limit", async () => {
    const body = `"${"x".repeat(98)}"`;
    expect(body).toHaveLength(100);
    expect(await readJson(fakeRequest(JSON_TYPE, [body]), 100)).toHaveLength(98);
  });

  it("reports a client hanging up mid-body as a ClientAbortError, not a 400", async () => {
    await expect(readJson(fakeRequest(JSON_TYPE, ['{"a":'], { abort: true }), 100)).rejects.toBeInstanceOf(ClientAbortError);
  });
});

describe("streamToFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "holt-body-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the body and returns its size", async () => {
    const file = path.join(dir, "001-screenshot.png");
    expect(await streamToFile(fakeRequest({}, ["abc", "def"]), file, 100)).toBe(6);
    expect(await readFile(file, "utf8")).toBe("abcdef");
  });

  it("returns 0 for an empty body (the route turns that into a 400)", async () => {
    expect(await streamToFile(fakeRequest({}), path.join(dir, "empty.png"), 100)).toBe(0);
  });

  it("rejects an announced oversize body without creating the file", async () => {
    const file = path.join(dir, "big.png");
    expect((await httpError(streamToFile(fakeRequest({ "content-length": "101" }, ["x"]), file, 100))).status).toBe(413);
    expect(await readdir(dir)).toEqual([]);
  });

  it("stops at the limit while streaming and deletes the partial file", async () => {
    const file = path.join(dir, "big.png");
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(40, 1));
    expect((await httpError(streamToFile(fakeRequest({}, chunks), file, 100))).status).toBe(413);
    expect(await readdir(dir)).toEqual([]);
  });

  it("deletes the partial file when the client hangs up", async () => {
    const file = path.join(dir, "cut.png");
    await expect(streamToFile(fakeRequest({}, ["partial"], { abort: true }), file, 100)).rejects.toBeInstanceOf(ClientAbortError);
    expect(await readdir(dir)).toEqual([]);
  });

  it("never overwrites (or deletes) a file that already exists at the path", async () => {
    const file = path.join(dir, "001-screenshot.png");
    await writeFile(file, "original");
    await expect(streamToFile(fakeRequest({}, ["attack"]), file, 100)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(file, "utf8")).toBe("original");
  });
});
