/**
 * HTTP API. All paths are relative to BASE_PATH.
 *
 *   GET  /status                 -> StatusResponse
 *   POST /session/start          -> SessionResponse   body: StartSessionRequest
 *   POST /session/stop           -> SessionResponse
 *   POST /media                  -> MediaUploadResponse
 *          raw bytes in the body; `Content-Type` must be in ACCEPTED_MEDIA_TYPES;
 *          `x-nitpick-kind` header says which entry kind the bytes are for
 *          (used only to pick a readable file name).
 *   POST /entries                -> EntryResponse     body: EntryInput
 *
 * Every request must carry `x-nitpick-client: extension` and, if the server
 * is configured with a token, `x-nitpick-token`.
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
 * "acme-web" rather than just "nitpick 0.1.0" when several are running.
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
  /** The tool, always "nitpick". See `project` for what it is serving. */
  name: "nitpick";
  /** The nitpick server package version. */
  version: string;
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
