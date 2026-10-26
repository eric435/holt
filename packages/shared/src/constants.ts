/**
 * The version of the extension <-> server protocol (everything in this
 * package), reported by the server as `protocolVersion` in `GET /status`.
 *
 * Why it exists: the extension auto-updates from the Chrome Web Store,
 * while every project pins its own `@velvet-thunder/holt` in
 * devDependencies, so an extension and a server from different releases
 * meeting each other is the normal case, not an accident. The shared types
 * only line up at compile time; this number is how the two find out at run
 * time whether they still understand each other, and the extension refuses
 * a server that speaks another version up front (with a message saying
 * which side to update) instead of failing later with a confusing 400.
 *
 * The rule: bump it ONLY for breaking changes, i.e. when a server or an
 * extension of the previous version would misbehave against the new one:
 *   - a route or a field is removed or renamed;
 *   - a field changes meaning, type or format;
 *   - an optional field becomes required, or a new required one appears
 *     in a request the extension sends.
 * Do NOT bump it for additive changes that old peers cope with:
 *   - a new optional field (an old server drops unknown keys, an old
 *     extension ignores fields it doesn't read);
 *   - a new entry kind: an old server refuses it with a 400 that says the
 *     extension is newer than the server and how to update the server
 *     (packages/server/src/http/entry-input.ts), which the user sees.
 *
 * Servers before `protocolVersion` existed (0.0.2 and older) speak version
 * 1, so a status without the field counts as 1.
 */
export const PROTOCOL_VERSION = 1;

/** Default TCP port for the standalone server (`npx holt`). */
export const DEFAULT_PORT = 4848;

/** Loopback only. Never bind to 0.0.0.0: the server writes files to disk. */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * All server routes live under this prefix so the same request handler can be
 * mounted either on its own port (standalone) or inside an existing dev server
 * (Vite plugin) without route collisions with the user's app.
 */
export const BASE_PATH = "/__holt";

/** Default directory (relative to the project root) where sessions are written. */
export const DEFAULT_OUTPUT_DIR = "qa";

/** Name of the markdown file inside each session folder. */
export const SESSION_FILE_NAME = "notes.md";

/**
 * Custom request header the extension must send on every request.
 *
 * Why: a plain `fetch` from any web page can hit `http://127.0.0.1:4848`
 * with a "simple" request (e.g. text/plain POST) and the browser will NOT
 * send a CORS preflight. Requiring a custom header turns every cross-origin
 * request into a preflighted one, and the server only answers the preflight
 * for `chrome-extension://` origins. A random website therefore cannot
 * write into your repo through holt.
 */
export const CLIENT_HEADER = "x-holt-client";
export const CLIENT_HEADER_VALUE = "extension";

/** Optional shared secret, configured in holt.config.json and the extension. */
export const TOKEN_HEADER = "x-holt-token";

/** Header the extension sets on media uploads to say what the bytes are. */
export const KIND_HEADER = "x-holt-kind";

/** Upload size limit the server enforces by default (bytes). Configurable. */
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Media types the server will accept for uploads, mapped to file extensions. */
export const ACCEPTED_MEDIA_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/webm": "webm",
  "video/mp4": "mp4",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
};

/**
 * Longest value the server accepts for each free-text field of an entry
 * (`POST /entries`), in characters (JavaScript string length, i.e. UTF-16
 * code units). Anything longer is a 400 naming the field.
 *
 * Why per-field caps when the JSON body already has a size limit: the body
 * limit bounds the request, not each field. A page title or URL that a
 * hostile page made megabytes long would otherwise be written into notes.md
 * (and echoed back in the response) in full. The numbers are
 * far above anything real: browsers cap tab titles well under 1,000, real
 * URLs fit in 8 KiB (most servers reject longer ones), the extension itself
 * refuses transcripts over 100,000 characters, and file names come from
 * the server (`003-screenshot.png`) and filesystems stop at 255.
 */
export const ENTRY_FIELD_LIMITS = {
  "page.title": 1_000,
  "page.url": 8_192,
  note: 100_000,
  file: 255,
} as const;

/** Name of the config file the server looks for in the project root. */
export const CONFIG_FILE_NAME = "holt.config.json";
