/**
 * Client for the nitpick server's HTTP API (see @nitpick/protocol http.ts).
 *
 * Used by BOTH the service worker (screenshots) and the side panel (screen
 * recordings, voice notes, typed notes). Recordings are created in the panel
 * and a Blob cannot be passed to the worker cheaply (messages are
 * JSON-serialised), so the panel uploads them itself. Both contexts are
 * extension origins with the same host_permissions, so the server sees the
 * same `chrome-extension://<id>` Origin either way.
 *
 * Every request carries the custom client header (forces a CORS preflight for
 * any web page that tries to impersonate us, see SECURITY.md) and the token
 * if one is configured.
 *
 * `createApi` takes its config explicitly and has no chrome.* dependencies,
 * so tests can drive it with a stubbed global `fetch`.
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
} from "@nitpick/protocol";
import { loadSettings } from "./settings.js";

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
 */
export type ApiErrorCode = ErrorCode | "unreachable" | "bad-response";

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
    `Can't reach the nitpick server at ${serverUrl}. ` +
    "Start it with `npx nitpick-notes` in your project, or add the nitpick Vite plugin " +
    "and set the server URL to your dev server (Settings)."
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
  status(): Promise<StatusResponse>;
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
      response = await globalThis.fetch(base + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      throw new ApiError(
        "unreachable",
        timedOut ? `The nitpick server at ${config.serverUrl} did not answer in time.` : unreachableMessage(config.serverUrl),
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        "bad-response",
        `Unexpected response from ${config.serverUrl}${BASE_PATH}${path} (HTTP ${response.status}). Is the server URL pointing at nitpick?`,
        response.status,
      );
    }

    if (isErrorBody(body)) {
      const hint =
        body.error.code === "forbidden"
          ? " Check that the token in Settings matches the server's nitpick.config.json."
          : "";
      throw new ApiError(body.error.code, body.error.message + hint, response.status);
    }
    if (!response.ok || !isOkBody(body)) {
      throw new ApiError("bad-response", `Unexpected response from nitpick (HTTP ${response.status}).`, response.status);
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
    status: () => request<StatusResponse>("/status", { method: "GET", headers: headers() }, STATUS_TIMEOUT_MS),

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
 * Convenience for callers in the extension: build a client from the current
 * settings. Settings are read from storage on every call (cheap), because the
 * worker may have been restarted since the last call and the user may have
 * changed them in the panel.
 */
export async function getApi(): Promise<Api & { serverUrl: string }> {
  const settings = await loadSettings();
  return { ...createApi(settings), serverUrl: settings.serverUrl };
}
