import {
  BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  KIND_HEADER,
  TOKEN_HEADER,
  type EntryInput,
} from "@holt/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, baseMediaType, createApi } from "./api.js";

const SERVER = "http://127.0.0.1:4848";
const session = { id: "s1", dir: "/repo/qa/x", markdownFile: "qa/x/notes.md", startedAt: "t", entryCount: 0 };

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The (url, init) of the n-th fetch call. */
function call(n = 0): { url: string; init: RequestInit; headers: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request shaping", () => {
  it("GET /status under the base path with the client header and no token", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, name: "holt", version: "1", session: null, config: {} }));
    const status = await createApi({ serverUrl: SERVER, token: "" }).status();
    expect(status.name).toBe("holt");
    const { url, init, headers } = call();
    expect(url).toBe(`${SERVER}${BASE_PATH}/status`);
    expect(init.method).toBe("GET");
    expect(headers[CLIENT_HEADER]).toBe(CLIENT_HEADER_VALUE);
    expect(headers).not.toHaveProperty(TOKEN_HEADER);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the token when configured", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, session }));
    await createApi({ serverUrl: SERVER, token: "s3cret" }).stopSession();
    expect(call().headers[TOKEN_HEADER]).toBe("s3cret");
  });

  it("tolerates a trailing slash on the server URL", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, session }));
    await createApi({ serverUrl: `${SERVER}/`, token: "" }).stopSession();
    expect(call().url).toBe(`${SERVER}${BASE_PATH}/session/stop`);
  });

  it("POST /session/start with a JSON body, omitting an empty title", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, session }));
    const api = createApi({ serverUrl: SERVER, token: "" });
    await api.startSession("  Checkout pass  ");
    await api.startSession("   ");
    expect(call(0).url).toBe(`${SERVER}${BASE_PATH}/session/start`);
    expect(call(0).init.method).toBe("POST");
    expect(call(0).headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call(0).init.body as string)).toEqual({ title: "Checkout pass" });
    expect(JSON.parse(call(1).init.body as string)).toEqual({});
  });

  it("POST /entries with the entry as JSON", async () => {
    const entry: EntryInput = { kind: "note", capturedAt: "2026-10-13T00:00:00Z", page: { url: "u", title: "t" }, text: "hi" };
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, entry: { ...entry, id: "e1", seq: 1, receivedAt: "r" }, session }));
    const res = await createApi({ serverUrl: SERVER, token: "" }).postEntry(entry);
    expect(res.entry.seq).toBe(1);
    expect(call().url).toBe(`${SERVER}${BASE_PATH}/entries`);
    expect(JSON.parse(call().init.body as string)).toEqual(entry);
  });

  it("POST /media with raw bytes, base content type and the kind header", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, file: "001-recording.webm", bytes: 3, session }));
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm;codecs=vp9,opus" });
    const res = await createApi({ serverUrl: SERVER, token: "" }).uploadMedia(blob, "recording");
    expect(res.file).toBe("001-recording.webm");
    const { url, init, headers } = call();
    expect(url).toBe(`${SERVER}${BASE_PATH}/media`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(blob);
    expect(headers["content-type"]).toBe("video/webm");
    expect(headers[KIND_HEADER]).toBe("recording");
    expect(headers[CLIENT_HEADER]).toBe(CLIENT_HEADER_VALUE);
  });

  it("refuses to upload a media type the server won't accept, without calling fetch", async () => {
    const blob = new Blob(["x"], { type: "image/gif" });
    await expect(createApi({ serverUrl: SERVER, token: "" }).uploadMedia(blob, "screenshot")).rejects.toMatchObject({
      code: "unsupported-media-type",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  it("maps a network failure to 'unreachable' with the URL and how to start the server", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const error = await createApi({ serverUrl: SERVER, token: "" }).status().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "unreachable" });
    expect((error as Error).message).toContain(SERVER);
    expect((error as Error).message).toContain("npx holt");
    expect((error as Error).message).toContain("Vite plugin");
  });

  it("maps a timeout to 'unreachable'", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(createApi({ serverUrl: SERVER, token: "" }).status()).rejects.toMatchObject({
      code: "unreachable",
      message: expect.stringMatching(/did not answer in time/),
    });
  });

  it("passes server error codes through, with a token hint for 'forbidden'", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: false, error: { code: "forbidden", message: "Bad token." } }, 403));
    await expect(createApi({ serverUrl: SERVER, token: "x" }).status()).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
      message: expect.stringMatching(/^Bad token\. Check that the token/),
    });
  });

  it("passes other server errors through unchanged", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: false, error: { code: "payload-too-large", message: "Too big." } }, 413));
    await expect(createApi({ serverUrl: SERVER, token: "" }).stopSession()).rejects.toMatchObject({
      code: "payload-too-large",
      message: "Too big.",
      status: 413,
    });
  });

  it("maps a non-JSON response to 'bad-response'", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>Vite</html>", { status: 404 }));
    await expect(createApi({ serverUrl: SERVER, token: "" }).status()).rejects.toMatchObject({
      code: "bad-response",
      status: 404,
    });
  });

  it("maps JSON without ok:true to 'bad-response'", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ hello: "world" }));
    await expect(createApi({ serverUrl: SERVER, token: "" }).status()).rejects.toMatchObject({ code: "bad-response" });
  });
});

describe("baseMediaType", () => {
  it("strips parameters and lowercases", () => {
    expect(baseMediaType("Audio/WebM; codecs=opus")).toBe("audio/webm");
    expect(baseMediaType("image/png")).toBe("image/png");
    expect(baseMediaType("")).toBe("");
  });
});
