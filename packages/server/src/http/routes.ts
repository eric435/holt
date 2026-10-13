/**
 * The five API routes (see packages/shared/src/http.ts for the contract).
 *
 * Each route is a plain async function: (req, ctx) -> response body. By the
 * time a route runs, the handler has already done all access checks, so
 * routes only deal with input validation and calling the session store.
 */
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import {
  ACCEPTED_MEDIA_TYPES,
  KIND_HEADER,
  type ApiResponse,
  type EntryResponse,
  type MediaUploadResponse,
  type SessionResponse,
  type StatusResponse,
} from "@nitpick/protocol";
import { MAX_JSON_BYTES, MAX_TITLE_LENGTH } from "../config/defaults.js";
import type { ResolvedConfig } from "../config/types.js";
import type { Logger } from "../log.js";
import { isMediaKind, MEDIA_KINDS } from "../session/naming.js";
import { pluralEntries } from "../session/markdown.js";
import type { SessionStore } from "../session/store.js";
import { VERSION } from "../version.js";
import { assertContentLengthWithin, mediaType, readJson, streamToFile } from "./body.js";
import { parseEntryInput } from "./entry-input.js";
import { HttpError } from "./errors.js";

export interface RouteContext {
  config: ResolvedConfig;
  sessions: SessionStore;
  logger: Logger;
}

type Route = (req: IncomingMessage, ctx: RouteContext) => Promise<ApiResponse>;

/** Keyed by "METHOD /path" (path relative to BASE_PATH). */
export const routes: Readonly<Record<string, Route>> = {
  "GET /status": status,
  "POST /session/start": startSession,
  "POST /session/stop": stopSession,
  "POST /media": uploadMedia,
  "POST /entries": addEntry,
};

async function status(_req: IncomingMessage, { config, sessions }: RouteContext): Promise<StatusResponse> {
  return {
    ok: true,
    name: "nitpick",
    version: VERSION,
    session: sessions.current,
    config: {
      outputDir: displayPath(config.root, config.outputDir),
      requiresToken: config.token !== null,
    },
  };
}

async function startSession(req: IncomingMessage, { sessions, logger }: RouteContext): Promise<SessionResponse> {
  const body = await readJson(req, MAX_JSON_BYTES);
  let title: string | undefined;
  if (body !== undefined) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new HttpError(400, "bad-request", "Body must be a JSON object");
    }
    const raw = (body as { title?: unknown }).title;
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== "string") throw new HttpError(400, "bad-request", `"title" must be a string`);
      if (raw.length > MAX_TITLE_LENGTH) {
        throw new HttpError(400, "bad-request", `"title" must be at most ${MAX_TITLE_LENGTH} characters`);
      }
      title = raw.trim() || undefined;
    }
  }
  const session = await sessions.start(title);
  logger.info(`Started session ${session.markdownFile}`);
  return { ok: true, session };
}

async function stopSession(_req: IncomingMessage, { sessions, logger }: RouteContext): Promise<SessionResponse> {
  const session = await sessions.stop();
  if (session) logger.info(`Ended session ${session.markdownFile} (${pluralEntries(session.entryCount)})`);
  return { ok: true, session };
}

async function uploadMedia(req: IncomingMessage, { config, sessions }: RouteContext): Promise<MediaUploadResponse> {
  // Validate everything we can *before* reserving a number or touching disk.
  const type = mediaType(req);
  // Object.hasOwn, not `in` or a plain lookup: "constructor" or "__proto__"
  // must not count as a supported media type.
  if (type === undefined || !Object.hasOwn(ACCEPTED_MEDIA_TYPES, type)) {
    throw new HttpError(
      415,
      "unsupported-media-type",
      `Content-Type must be one of: ${Object.keys(ACCEPTED_MEDIA_TYPES).join(", ")}`,
    );
  }
  const ext = ACCEPTED_MEDIA_TYPES[type] as string;

  const kind = req.headers[KIND_HEADER] ?? "media";
  if (!isMediaKind(kind)) {
    throw new HttpError(400, "bad-request", `"${KIND_HEADER}" must be one of: ${MEDIA_KINDS.join(", ")}`);
  }
  assertContentLengthWithin(req, config.maxUploadBytes);

  const media = await sessions.reserveMedia(kind, ext);
  let bytes: number;
  try {
    bytes = await streamToFile(req, media.path, config.maxUploadBytes);
  } catch (err) {
    sessions.releaseMedia(media.file);
    throw err;
  }
  if (bytes === 0) {
    sessions.releaseMedia(media.file);
    await rm(media.path, { force: true });
    throw new HttpError(400, "bad-request", "Upload body is empty");
  }
  return { ok: true, file: media.file, bytes, session: sessions.current ?? media.session };
}

async function addEntry(req: IncomingMessage, { sessions }: RouteContext): Promise<EntryResponse> {
  const body = await readJson(req, MAX_JSON_BYTES);
  if (body === undefined) throw new HttpError(400, "bad-request", "Body is required");
  const input = parseEntryInput(body);
  const { entry, session } = await sessions.addEntry(input);
  return { ok: true, entry, session };
}

/** "qa" when inside the project root, the absolute path otherwise. */
function displayPath(root: string, target: string): string {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : target;
}
