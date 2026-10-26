/**
 * HTTP API. All paths are relative to BASE_PATH.
 *
 *   GET  /status                 -> StatusResponse
 *          carries `protocolVersion` (PROTOCOL_VERSION in constants.ts):
 *          the extension checks it before it captures anything.
 *   POST /session/start         -> SessionResponse   body: StartSessionRequest
 *   POST /session/stop           -> SessionResponse
 *   POST /media                  -> MediaUploadResponse
 *          raw bytes in the body; `Content-Type` must be in ACCEPTED_MEDIA_TYPES;
 *          `x-holt-kind` header says which entry kind the bytes are for:
 *          it picks a readable file name, and only an entry of that kind
 *          may reference the file (else 400). Without the header the file
 *          is named `NNN-media.ext` and any media entry may use it.
 *   POST /entries                -> EntryResponse     body: EntryInput
 *          per-field length caps (ENTRY_FIELD_LIMITS): page.title 1,000
 *          characters, page.url 8,192, note 100,000, file 255; longer is a
 *          400 naming the field. The retired keys `transcript` and `text`
 *          are a 400 ("the extension is out of date"), not ignored. An
 *          entry `kind` the server doesn't know is a 400 saying the
 *          extension is probably newer than the server, and how to update
 *          the server. Other unknown keys are dropped.
 *
 * Every request must carry `x-holt-client: extension` and, if the server
 * is configured with a token, `x-holt-token`.
 *
 * Errors are returned as `{ ok: false, error: { code, message } }` with an
 * appropriate HTTP status.
 *
 * If there is no active session when a media upload or entry arrives, the
 * server starts one automatically ("start recording in chrome creates the
 * folder"). Starting a session explicitly closes the previous one.
 */

import type { Entry, EntryInput, EntryKind } from "./entries.js";

export interface SessionInfo {
  id: string;
  /** Absolute path on disk, for display in the extension. */
  dir: string;
  /** Path of the markdown file relative to the project root. */
  markdownFile: string;
  startedAt: string;
  endedAt?: string;
  entryCount: number;
}

/**
 * Which project this server writes into, so the extension can say
 * "acme-web" rather than just "holt 0.1.0" when several are running.
 */
export interface ProjectInfo {
  /** Display name, at most 100 characters. */
  name: string;
  /**
   * Where the name came from: the `projectName` config option, the `name`
   * field of <root>/package.json, or the root directory's base name.
   */
  source: "config" | "package.json" | "directory";
}

export interface StatusResponse {
  ok: true;
  /** The tool, always "holt". See `project` for what it is serving. */
  name: "holt";
  /** The holt server package version (for display; compatibility is `protocolVersion`). */
  version: string;
  /**
   * PROTOCOL_VERSION (constants.ts) of the server. Missing from servers
   * 0.0.2 and older, which speak protocol 1; the extension reads a status
   * without it as 1.
   */
  protocolVersion: number;
  project: ProjectInfo;
  session: SessionInfo | null;
  /** Non-secret config the extension may want to show. */
  config: {
    outputDir: string;
    requiresToken: boolean;
  };
}

export interface StartSessionRequest {
  /** Optional human title; becomes the H1 of the markdown file. */
  title?: string;
}

export interface SessionResponse {
  ok: true;
  session: SessionInfo | null;
}

export interface MediaUploadResponse {
  ok: true;
  /** File name (no directories) the entry should reference. */
  file: string;
  bytes: number;
  session: SessionInfo;
}

export interface EntryResponse {
  ok: true;
  entry: Entry;
  session: SessionInfo;
}

export type ErrorCode =
  | "bad-request"
  | "forbidden"
  | "unsupported-media-type"
  | "payload-too-large"
  | "not-found"
  /** The request raced with a session change (e.g. an upload finished after a new session started). Retry. */
  | "conflict"
  /** A per-session limit was hit (e.g. too many uploads not yet referenced by an entry). */
  | "too-many-requests"
  | "internal";

export interface ErrorResponse {
  ok: false;
  error: { code: ErrorCode; message: string };
}

export type ApiResponse =
  | StatusResponse
  | SessionResponse
  | MediaUploadResponse
  | EntryResponse
  | ErrorResponse;

/** Re-exported for convenience so clients only import from the package root. */
export type { Entry, EntryInput, EntryKind };
