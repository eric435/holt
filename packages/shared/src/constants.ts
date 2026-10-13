/** Default TCP port for the standalone server (`npx nitpick`). */
export const DEFAULT_PORT = 4848;

/** Loopback only. Never bind to 0.0.0.0: the server writes files to disk. */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * All server routes live under this prefix so the same request handler can be
 * mounted either on its own port (standalone) or inside an existing dev server
 * (Vite plugin) without route collisions with the user's app.
 */
export const BASE_PATH = "/__nitpick";

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
 * write into your repo through nitpick.
 */
export const CLIENT_HEADER = "x-nitpick-client";
export const CLIENT_HEADER_VALUE = "extension";

/** Optional shared secret, configured in nitpick.config.json and the extension. */
export const TOKEN_HEADER = "x-nitpick-token";

/** Header the extension sets on media uploads to say what the bytes are. */
export const KIND_HEADER = "x-nitpick-kind";

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

/** Name of the config file the server looks for in the project root. */
export const CONFIG_FILE_NAME = "nitpick.config.json";
