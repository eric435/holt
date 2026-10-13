/**
 * Error and JSON response helpers.
 *
 * Route code throws `HttpError` for anything the client did wrong; the
 * handler catches it in one place and turns it into the protocol's
 * `ErrorResponse` (`{ ok: false, error: { code, message } }`). Anything else
 * that is thrown is a bug on our side: it is logged in full on the server
 * and reported to the client as a generic 500, without internals.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiResponse, ErrorCode, ErrorResponse } from "@nitpick/protocol";
import type { Logger } from "../log.js";
import { SessionError } from "../session/store.js";

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
  let httpError: HttpError;
  if (err instanceof HttpError) {
    httpError = err;
  } else if (err instanceof SessionError) {
    httpError = new HttpError(400, "bad-request", err.message);
  } else {
    logger.error(`${req.method} ${req.url} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    httpError = new HttpError(500, "internal", "Internal error; see the nitpick server log");
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
