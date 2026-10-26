/**
 * Client for the holt server's HTTP API (see @holt/protocol http.ts).
 *
 * Used by every context that creates entries: the service worker
 * (screenshots), the offscreen document (tab recordings, voice notes) and
 * the note popup (quick notes); the side panel uses it for the server's
 * status and to start or end a session. Recordings are Blobs and a Blob cannot be passed between contexts cheaply
 * (messages are JSON-serialised), so whoever records uploads. All of them
 * are extension origins with the same host_permissions, so the server sees
 * the same `chrome-extension://<id>` Origin either way.
 *
 * Every request carries the custom client header (forces a CORS preflight for
 * any web page that tries to impersonate us, see SECURITY.md) and the token
 * if one is configured, and refuses redirects (`redirect: "error"`): the
 * server is on loopback, and a redirect from whatever answers there must
 * not carry a probe or the token to another machine.
 *
 * `createApi` takes its config explicitly and this module imports nothing
 * that touches chrome.* (the settings-based `getApi` lives in
 * shared/server.ts), so tests can drive it with a stubbed global `fetch`,
 * and the protocol contract test
 * (packages/server/src/http/extension-contract.test.ts) can run it in Node
 * against the real server.
 */

import {
  ACCEPTED_MEDIA_TYPES,
  BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  KIND_HEADER,
  TOKEN_HEADER,
  type EntryInput,
  type EntryKind,
  type EntryResponse,
  type ErrorCode,
  type MediaUploadResponse,
  type SessionResponse,
  type StartSessionRequest,
  type StatusResponse,
} from "@holt/protocol";

export interface ApiConfig {
  /** Bare origin, already validated by settings.ts. */
  serverUrl: string;
  /** Empty string = no token. */
  token: string;
}

/**
 * Error codes: the server's own, plus client-side ones:
 *  - `unreachable`  network error / connection refused / timeout
 *  - `bad-response` the server answered with something that isn't our JSON
 *  - `incompatible` holt answered, but speaks another protocol version
 *                   (shared/protocol-compat.ts; thrown by shared/server.ts)
 */
export type ApiErrorCode = ErrorCode | "unreachable" | "bad-response" | "incompatible";

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Hint shown whenever the server cannot be reached. */
export function unreachableMessage(serverUrl: string): string {
  return (
    `Can't reach the holt server at ${serverUrl}. ` +
    "Start it with `npx @velvet-thunder/holt` in your project, or add the holt Vite plugin " +
    "to your dev server (holt finds it on that server's pages by itself)."
  );
}

const STATUS_TIMEOUT_MS = 3_000;
const JSON_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** `video/webm;codecs=vp9,opus` -> `video/webm` (the server keys on the base type). */
export function baseMediaType(type: string): string {
  return (type.split(";")[0] ?? "").trim().toLowerCase();
}

export interface Api {
  /** `timeoutMs` defaults to a few seconds; the server probe (server-resolve.ts) uses a shorter one. */
  status(options?: { timeoutMs?: number }): Promise<StatusResponse>;
  startSession(title?: string): Promise<SessionResponse>;
  stopSession(): Promise<SessionResponse>;
  uploadMedia(blob: Blob, kind: EntryKind): Promise<MediaUploadResponse>;
  postEntry(entry: EntryInput): Promise<EntryResponse>;
}

export function createApi(config: ApiConfig): Api {
  const base = config.serverUrl.replace(/\/+$/, "") + BASE_PATH;

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, ...extra };
    if (config.token) h[TOKEN_HEADER] = config.token;
    return h;
  }

  async function request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    let response: Response;
    try {
      // Look `fetch` up on globalThis at call time (so tests can stub it) and
      // call it as a plain function. Calling a stored reference as a method
      // of some other object (`opts.fetch(...)`) throws "Illegal invocation"
      // in browsers.
      // redirect: "error": see the header (a loopback server must not bounce us elsewhere).
      response = await globalThis.fetch(base + path, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new ApiError(
        "unreachable",
        timedOut ? `The holt server at ${config.serverUrl} did not answer in time.` : unreachableMessage(config.serverUrl),
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        "bad-response",
        `Unexpected response from ${config.serverUrl}${BASE_PATH}${path} (HTTP ${response.status}). Is the server URL pointing at holt?`,
        response.status,
      );
    }

    if (isErrorBody(body)) {
      // Only when the token is what the server objected to: holt's other
      // `forbidden`s (a non-loopback Host, a disallowed Origin) have nothing to do with it.
      const hint =
        body.error.code === "forbidden" && body.error.message.includes(TOKEN_HEADER)
          ? " Check that the token in Settings matches the server's holt.config.json."
          : "";
      throw new ApiError(body.error.code, body.error.message + hint, response.status);
    }
    if (!response.ok || !isOkBody(body)) {
      throw new ApiError("bad-response", `Unexpected response from holt (HTTP ${response.status}).`, response.status);
    }
    return body as T;
  }

  function postJson<T>(path: string, payload: unknown): Promise<T> {
    return request<T>(
      path,
      { method: "POST", headers: headers({ "content-type": "application/json" }), body: JSON.stringify(payload) },
      JSON_TIMEOUT_MS,
    );
  }

  return {
    status: (options) => request<StatusResponse>("/status", { method: "GET", headers: headers() }, options?.timeoutMs ?? STATUS_TIMEOUT_MS),

    startSession: (title?: string) => {
      const payload: StartSessionRequest = {};
      const trimmed = title?.trim();
      if (trimmed) payload.title = trimmed;
      return postJson<SessionResponse>("/session/start", payload);
    },

    stopSession: () => postJson<SessionResponse>("/session/stop", {}),

    uploadMedia: async (blob: Blob, kind: EntryKind) => {
      const type = baseMediaType(blob.type);
      if (!(type in ACCEPTED_MEDIA_TYPES)) {
        throw new ApiError("unsupported-media-type", `The server does not accept "${blob.type || "unknown"}" files.`);
      }
      return request<MediaUploadResponse>(
        "/media",
        { method: "POST", headers: headers({ "content-type": type, [KIND_HEADER]: kind }), body: blob },
        UPLOAD_TIMEOUT_MS,
      );
    },

    postEntry: (entry: EntryInput) => postJson<EntryResponse>("/entries", entry),
  };
}

function isErrorBody(body: unknown): body is { ok: false; error: { code: ErrorCode; message: string } } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
  return b.ok === false && typeof b.error?.code === "string" && typeof b.error.message === "string";
}

function isOkBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
}

/**
 * Is this /status body from holt (and not some other app's `/__holt/status`
 * that happens to answer `{ ok: true }`)?
 */
export function isHoltStatus(body: unknown): body is StatusResponse {
  return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true && (body as { name?: unknown }).name === "holt";
}
