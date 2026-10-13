/**
 * Error and JSON response helpers.
 *
 * Route code throws `HttpError` for anything the client did wrong; the
 * handler catches it in one place and turns it into the protocol's
 * `ErrorResponse` (`{ ok: false, error: { code, message } }`). Anything else
 * that is thrown is a bug on our side: it is logged in full on the server
 * and reported to the client as a generic 500, without internals.
 *
 * The exception is `ClientAbortError`: a client hanging up mid-request
 * (closed tab, cancelled upload) is normal, so it gets a one-line info log
 * and no response, since there is nobody left to send one to.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiResponse, ErrorCode, ErrorResponse } from "@holt/protocol";
import type { Logger } from "../log.js";
import { SessionError, type SessionErrorReason } from "../session/store.js";

export class HttpError extends Error {
  override name = "HttpError";

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The client disconnected before its request body was complete. */
export class ClientAbortError extends Error {
  override name = "ClientAbortError";

  constructor() {
    super("Client disconnected before the request was complete");
  }
}

const SESSION_ERROR_STATUS: Record<SessionErrorReason, [number, ErrorCode]> = {
  invalid: [400, "bad-request"],
  conflict: [409, "conflict"],
  limit: [429, "too-many-requests"],
};

export function sendJson(res: ServerResponse, status: number, body: ApiResponse): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(json));
  // Responses describe live local state; never let anything cache them.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(json);
}

/** Turn any thrown value into an error response. */
export function sendError(req: IncomingMessage, res: ServerResponse, err: unknown, logger: Logger): void {
  if (err instanceof ClientAbortError) {
    logger.info(`${req.method} ${req.url}: client disconnected mid-request; nothing was saved`);
    return;
  }

  let httpError: HttpError;
  if (err instanceof HttpError) {
    httpError = err;
  } else if (err instanceof SessionError) {
    const [status, code] = SESSION_ERROR_STATUS[err.reason];
    httpError = new HttpError(status, code, err.message);
  } else {
    logger.error(`${req.method} ${req.url} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    httpError = new HttpError(500, "internal", "Internal error; see the holt server log");
  }

  // Nothing we can do if the client already went away or we already replied.
  if (res.headersSent || res.destroyed) return;

  // If we are rejecting a request before reading its body (e.g. a 413 on a
  // huge upload), close the connection instead of letting Node read and
  // discard the remaining bytes to keep the connection alive.
  if (!req.readableEnded) res.setHeader("Connection", "close");

  const body: ErrorResponse = { ok: false, error: { code: httpError.code, message: httpError.message } };
  sendJson(res, httpError.status, body);
}
