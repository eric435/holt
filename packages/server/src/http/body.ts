/**
 * Reading request bodies with hard size limits (docs/SECURITY.md, "Disk
 * exhaustion").
 *
 * Two shapes:
 *  - readJson: small bodies, buffered in memory, capped at MAX_JSON_BYTES.
 *  - streamToFile: media, streamed straight to disk, capped at
 *    maxUploadBytes. Memory use stays flat no matter how big the upload.
 *
 * Both reject as early as possible: first on a too-large Content-Length
 * header, then while counting bytes as they arrive (the header is optional
 * with chunked encoding, and clients can lie).
 *
 * A subtle point: we never call `req.destroy()` on overflow. Destroying an
 * unfinished request destroys its socket, and then we could not send the 413
 * response. Instead we stop reading and let the error response go out with
 * `Connection: close` (see errors.ts), which closes the socket afterwards.
 */
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ClientAbortError, HttpError } from "./errors.js";

/** The media type from Content-Type, lowercased and without parameters. */
export function mediaType(req: IncomingMessage): string | undefined {
  const raw = req.headers["content-type"];
  if (!raw) return undefined;
  return raw.split(";")[0]?.trim().toLowerCase() || undefined;
}

/** Reject immediately if the client announced a body bigger than `limit`. */
export function assertContentLengthWithin(req: IncomingMessage, limit: number): void {
  const header = req.headers["content-length"];
  if (header === undefined) return;
  const length = Number(header);
  if (Number.isFinite(length) && length > limit) throw tooLarge(limit);
}

/**
 * Read and parse a JSON body. Returns `undefined` for an empty body so
 * routes with optional bodies (session start) can accept a bare POST.
 */
export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = mediaType(req);
  if (type !== undefined && type !== "application/json") {
    throw new HttpError(415, "unsupported-media-type", "Content-Type must be application/json");
  }
  assertContentLengthWithin(req, limit);

  const raw = await readBody(req, limit);
  if (raw.length === 0) return undefined;
  if (type === undefined) {
    throw new HttpError(415, "unsupported-media-type", "Content-Type must be application/json");
  }
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "bad-request", "Body is not valid JSON");
  }
}

/** Buffer a body in memory, failing as soon as it exceeds `limit`. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.pause(); // stop reading; see the module comment for why not destroy()
        reject(tooLarge(limit));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    // A request stream only errors when its socket does, and 'close'
    // without 'end' means the client hung up mid-body: both are aborts.
    const onError = (): void => {
      cleanup();
      reject(new ClientAbortError());
    };
    const onClose = (): void => {
      cleanup();
      reject(new ClientAbortError());
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

/**
 * Stream the request body into a new file at `filePath`, enforcing `limit`.
 * The file is created with the "wx" flag, so an existing file (or a symlink
 * planted at that path) is never overwritten or followed. On any failure
 * the partial file is deleted, so no half-written media is left behind.
 * Returns the number of bytes written.
 */
export async function streamToFile(req: IncomingMessage, filePath: string, limit: number): Promise<number> {
  assertContentLengthWithin(req, limit);

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) callback(tooLarge(limit));
      else callback(null, chunk);
    },
  });
  const out = createWriteStream(filePath, { flags: "wx" });
  // Only delete the file on failure if *we* created it. If opening failed
  // because the name exists, that file is not ours to remove.
  let created = false;
  out.once("open", () => {
    created = true;
  });

  // `req.pipe` does not forward errors or aborts, so do it by hand;
  // otherwise a client disconnect would leave the pipeline waiting forever.
  const onReqError = (): void => {
    limiter.destroy(new ClientAbortError());
  };
  const onReqClose = (): void => {
    if (!req.complete) limiter.destroy(new ClientAbortError());
  };
  req.once("error", onReqError);
  req.once("close", onReqClose);
  req.pipe(limiter);

  try {
    await pipeline(limiter, out);
    return bytes;
  } catch (err) {
    req.unpipe(limiter);
    req.pause();
    if (created) await rm(filePath, { force: true });
    throw err;
  } finally {
    req.off("error", onReqError);
    req.off("close", onReqClose);
  }
}

function tooLarge(limit: number): HttpError {
  return new HttpError(413, "payload-too-large", `Body exceeds the limit of ${limit} bytes`);
}
