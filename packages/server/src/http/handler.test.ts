/**
 * Integration tests: a real standalone server on an ephemeral port, a temp
 * output directory, and real HTTP requests via fetch.
 */
import http from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  KIND_HEADER,
  TOKEN_HEADER,
  type EntryResponse,
  type ErrorResponse,
  type MediaUploadResponse,
  type SessionResponse,
  type StatusResponse,
} from "@nitpick/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startStandalone, type StandaloneServer } from "../adapters/standalone.js";
import type { NitpickConfig } from "../config/types.js";
import { createNitpick, type Nitpick } from "../core.js";
import { silentLogger } from "../log.js";
import { VERSION } from "../version.js";

const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const EXT_HEADERS = { origin: EXT_ORIGIN, [CLIENT_HEADER]: CLIENT_HEADER_VALUE };
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

let tempDir: string | undefined;
let running: StandaloneServer | undefined;
let extraServer: http.Server | undefined;

afterEach(async () => {
  await running?.close();
  extraServer?.closeAllConnections();
  extraServer?.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  running = extraServer = tempDir = undefined;
});

async function createInstance(overrides: NitpickConfig = {}): Promise<Nitpick> {
  tempDir = await mkdtemp(path.join(tmpdir(), "nitpick-http-"));
  return createNitpick({ cwd: tempDir, overrides: { port: 0, ...overrides }, logger: silentLogger });
}

/** Start a standalone server and return the API base URL. */
async function startServer(overrides: NitpickConfig = {}): Promise<{ api: string; nitpick: Nitpick }> {
  const nitpick = await createInstance(overrides);
  running = await startStandalone(nitpick, { logger: silentLogger });
  return { api: `${running.url}${BASE_PATH}`, nitpick };
}

const postJson = (url: string, body: unknown, headers: Record<string, string> = EXT_HEADERS) =>
  fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

const uploadPng = (api: string, headers: Record<string, string> = EXT_HEADERS) =>
  fetch(`${api}/media`, {
    method: "POST",
    headers: { ...headers, "content-type": "image/png", [KIND_HEADER]: "screenshot" },
    body: PNG_BYTES,
  });

/** All media files under the output dir (ignores notes.md and .gitignore). */
async function mediaFiles(outputDir: string): Promise<string[]> {
  const all = await readdir(outputDir, { recursive: true }).catch(() => [] as string[]);
  return all.filter((f) => /\d{3}-[a-z-]+\.[a-z0-9]+$/.test(f));
}

const screenshotEntry = (file: string) => ({
  kind: "screenshot",
  capturedAt: new Date().toISOString(),
  page: { url: "http://localhost:5173/checkout", title: "Checkout – My App" },
  file,
  mode: "viewport",
  width: 1280,
  height: 800,
  note: "Submit button overlaps the footer.",
});

describe("CORS and access control", () => {
  it("answers a preflight from a chrome-extension origin", async () => {
    const { api } = await startServer();
    const res = await fetch(`${api}/media`, {
      method: "OPTIONS",
      headers: {
        origin: EXT_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": `${CLIENT_HEADER}, content-type`,
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toContain(CLIENT_HEADER);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("refuses a preflight from a web page", async () => {
    const { api } = await startServer();
    const res = await fetch(`${api}/media`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses an actual (unpreflighted) request from a web page", async () => {
    const { api, nitpick } = await startServer();
    const res = await fetch(`${api}/session/start`, {
      method: "POST",
      headers: { origin: "https://evil.example", [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
    });
    expect(res.status).toBe(403);
    expect(nitpick.sessions.current).toBeNull();
  });

  it("allows a configured extra origin", async () => {
    const { api } = await startServer({ allowedOrigins: ["http://localhost:3000"] });
    const res = await fetch(`${api}/status`, {
      headers: { origin: "http://localhost:3000", [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  it("requires the client header (403), and still lets the extension read the error", async () => {
    const { api } = await startServer();
    const res = await fetch(`${api}/status`, { headers: { origin: EXT_ORIGIN } });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    const body = (await res.json()) as ErrorResponse;
    expect(body).toEqual({ ok: false, error: { code: "forbidden", message: expect.stringContaining(CLIENT_HEADER) } });
  });

  it("allows curl-style requests (no Origin) from loopback", async () => {
    const { api } = await startServer();
    const res = await fetch(`${api}/status`, { headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE } });
    expect(res.status).toBe(200);
  });

  it("rejects a non-loopback Host header (DNS rebinding)", async () => {
    const { api } = await startServer();
    const url = new URL(`${api}/status`);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get(
          { host: url.hostname, port: url.port, path: url.pathname, headers: { host: "evil.example:4848", [CLIENT_HEADER]: CLIENT_HEADER_VALUE } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        )
        .on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("checks the token when one is configured", async () => {
    const { api } = await startServer({ token: "correct-horse" });
    const wrong = await fetch(`${api}/status`, { headers: { ...EXT_HEADERS, [TOKEN_HEADER]: "battery-staple" } });
    expect(wrong.status).toBe(403);
    const missing = await fetch(`${api}/status`, { headers: EXT_HEADERS });
    expect(missing.status).toBe(403);
    const right = await fetch(`${api}/status`, { headers: { ...EXT_HEADERS, [TOKEN_HEADER]: "correct-horse" } });
    expect(right.status).toBe(200);
    expect(((await right.json()) as StatusResponse).config.requiresToken).toBe(true);
  });
});

describe("media uploads", () => {
  it("rejects unsupported media types with 415", async () => {
    const { api, nitpick } = await startServer();
    for (const type of ["text/plain", "text/html", "constructor", "__proto__"]) {
      const res = await fetch(`${api}/media`, {
        method: "POST",
        headers: { ...EXT_HEADERS, "content-type": type },
        body: "hello",
      });
      expect(res.status).toBe(415);
      expect(((await res.json()) as ErrorResponse).error.code).toBe("unsupported-media-type");
    }
    expect(nitpick.sessions.current).toBeNull();
  });

  it("rejects an unknown kind header with 400", async () => {
    const { api } = await startServer();
    const res = await fetch(`${api}/media`, {
      method: "POST",
      headers: { ...EXT_HEADERS, "content-type": "image/png", [KIND_HEADER]: "../../evil" },
      body: PNG_BYTES,
    });
    expect(res.status).toBe(400);
  });

  it("rejects an oversize upload by Content-Length with 413 before writing anything", async () => {
    const { api, nitpick } = await startServer({ maxUploadBytes: 1024 });
    const res = await fetch(`${api}/media`, {
      method: "POST",
      headers: { ...EXT_HEADERS, "content-type": "video/webm" },
      body: new Uint8Array(4096),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorResponse).error.code).toBe("payload-too-large");
    expect(await mediaFiles(nitpick.config.outputDir)).toEqual([]);
  });

  it("rejects an oversize streamed (chunked) upload with 413 and deletes the partial file", async () => {
    const { api, nitpick } = await startServer({ maxUploadBytes: 1024 });
    const chunk = new Uint8Array(700);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await fetch(`${api}/media`, {
      method: "POST",
      headers: { ...EXT_HEADERS, "content-type": "video/webm", [KIND_HEADER]: "recording" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    // The session was auto-started (the stream had to be read to find out)...
    expect(nitpick.sessions.current).not.toBeNull();
    // ...but no partial file is left behind.
    expect(await mediaFiles(nitpick.config.outputDir)).toEqual([]);
  });

  it("auto-starts a session on the first upload", async () => {
    const { api, nitpick } = await startServer();
    const res = await uploadPng(api);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MediaUploadResponse;
    expect(body.session.id).toBe(nitpick.sessions.current?.id);
    expect(body.file).toBe("001-screenshot.png");
  });
});

describe("entries", () => {
  it("rejects an entry that references a file that was never uploaded", async () => {
    const { api } = await startServer();
    const res = await postJson(`${api}/entries`, screenshotEntry("042-screenshot.png"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorResponse).error.code).toBe("bad-request");
  });

  it("rejects path-like file references", async () => {
    const { api } = await startServer();
    await uploadPng(api);
    for (const file of ["../001-screenshot.png", "/etc/passwd", "sub/001-screenshot.png"]) {
      const res = await postJson(`${api}/entries`, screenshotEntry(file));
      expect(res.status).toBe(400);
    }
  });

  it("rejects malformed entries with a message naming the field", async () => {
    const { api } = await startServer();
    const cases: Array<[unknown, RegExp]> = [
      [{ kind: "bogus" }, /"kind"/],
      [{ kind: "note", capturedAt: "yesterday", page: { url: "", title: "" }, text: "x" }, /"capturedAt"/],
      [{ kind: "note", capturedAt: new Date().toISOString(), page: { url: 1, title: "" }, text: "x" }, /"page\.url"/],
      [{ kind: "note", capturedAt: new Date().toISOString(), page: { url: "", title: "" }, text: "  " }, /"text"/],
      [{ ...screenshotEntry("001-screenshot.png"), mode: "fisheye" }, /"mode"/],
      [{ kind: "voice-note", capturedAt: new Date().toISOString(), page: { url: "", title: "" }, durationMs: 1 }, /"file", "transcript"/],
      [[1, 2], /JSON object/],
    ];
    for (const [body, message] of cases) {
      const res = await postJson(`${api}/entries`, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorResponse).error.message).toMatch(message);
    }
  });

  it("requires a JSON content type (415) and valid JSON (400)", async () => {
    const { api } = await startServer();
    const wrongType = await fetch(`${api}/entries`, {
      method: "POST",
      headers: { ...EXT_HEADERS, "content-type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
    const badJson = await fetch(`${api}/entries`, {
      method: "POST",
      headers: { ...EXT_HEADERS, "content-type": "application/json" },
      body: "{nope",
    });
    expect(badJson.status).toBe(400);
  });
});

describe("happy path", () => {
  it("start -> upload -> entries -> status -> stop, and notes.md has it all", async () => {
    const { api, nitpick } = await startServer();

    const started = (await (await postJson(`${api}/session/start`, { title: "Checkout pass" })).json()) as SessionResponse;
    expect(started.session?.entryCount).toBe(0);

    const upload = await uploadPng(api);
    expect(upload.status).toBe(200);
    expect(upload.headers.get("access-control-allow-origin")).toBe(EXT_ORIGIN);
    const media = (await upload.json()) as MediaUploadResponse;
    expect(media).toMatchObject({ ok: true, file: "001-screenshot.png", bytes: PNG_BYTES.length });

    const shotRes = await postJson(`${api}/entries`, screenshotEntry(media.file));
    expect(shotRes.status).toBe(200);
    const shot = (await shotRes.json()) as EntryResponse;
    expect(shot.entry).toMatchObject({ kind: "screenshot", seq: 1, file: "001-screenshot.png" });
    expect(shot.entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(shot.session.entryCount).toBe(1);

    const noteRes = await postJson(`${api}/entries`, {
      kind: "note",
      capturedAt: new Date().toISOString(),
      page: { url: "http://localhost:5173/checkout", title: "](http://evil) sneaky" },
      text: "Coupon field accepts whitespace-only input.",
      extraField: "dropped",
    });
    const note = (await noteRes.json()) as EntryResponse;
    expect(note.entry.seq).toBe(2);
    expect(note.entry).not.toHaveProperty("extraField");

    const status = (await (await fetch(`${api}/status`, { headers: EXT_HEADERS })).json()) as StatusResponse;
    expect(status).toMatchObject({
      ok: true,
      name: "nitpick",
      version: VERSION,
      session: { id: started.session?.id, entryCount: 2 },
      config: { outputDir: "qa", requiresToken: false },
    });

    const stopped = (await (await postJson(`${api}/session/stop`, {})).json()) as SessionResponse;
    expect(stopped.session?.endedAt).toBeDefined();
    expect(nitpick.sessions.current).toBeNull();

    const dir = started.session?.dir ?? "";
    expect(await readFile(path.join(dir, "001-screenshot.png"))).toEqual(PNG_BYTES);
    const notes = await readFile(path.join(dir, "notes.md"), "utf8");
    expect(notes).toMatch(/^# Checkout pass \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n/);
    expect(notes).toContain(`- Project: ${tempDir}`);
    expect(notes).toMatch(/## 1\. Screenshot · \d{2}:\d{2}:\d{2}\nPage: \[Checkout – My App\]\(http:\/\/localhost:5173\/checkout\)/);
    expect(notes).toContain("![Screenshot 1](./001-screenshot.png)");
    expect(notes).toContain("> Submit button overlaps the footer.");
    expect(notes).toContain("## 2. Note");
    expect(notes).toContain("Page: [\\](http://evil) sneaky](http://localhost:5173/checkout)");
    expect(notes).toContain("Coupon field accepts whitespace-only input.");
    expect(notes).toMatch(/_Session ended at .* \(2 entries\)\._\n$/);
  });

  it("returns 404 JSON for unknown routes under the base path", async () => {
    const { api } = await startServer();
    const res = await fetch(`${api}/nope`, { headers: EXT_HEADERS });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorResponse).error.code).toBe("not-found");
  });
});

describe("handler fall-through", () => {
  it("returns false (and writes nothing) for paths outside the base path", async () => {
    const nitpick = await createInstance();
    const results: boolean[] = [];
    extraServer = http.createServer((req, res) => {
      void nitpick.handler(req, res).then((handled) => {
        results.push(handled);
        if (!handled) {
          res.statusCode = 418;
          res.end("app");
        }
      });
    });
    await new Promise<void>((resolve) => extraServer?.listen(0, "127.0.0.1", resolve));
    const { port } = extraServer.address() as { port: number };
    const origin = `http://127.0.0.1:${port}`;

    for (const p of ["/", "/app/page", "/__nitpickx/status", `${BASE_PATH}/../status`]) {
      const res = await fetch(`${origin}${p}`, { headers: EXT_HEADERS });
      expect(res.status, p).toBe(418);
    }
    const ours = await fetch(`${origin}${BASE_PATH}/status`, { headers: EXT_HEADERS });
    expect(ours.status).toBe(200);
    expect(results).toEqual([false, false, false, false, true]);
  });
});
