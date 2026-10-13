/**
 * Default values for every config key, plus limits that are deliberately not
 * configurable. Where the protocol package already defines a default, we use
 * it so the extension and server cannot drift apart.
 */
import {
  DEFAULT_HOST,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_PORT,
} from "@nitpick/protocol";

export const DEFAULTS = {
  outputDir: DEFAULT_OUTPUT_DIR,
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  token: null,
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  sessionTitle: "QA session",
  allowedOrigins: [] as string[],
} as const;

/**
 * Limit for JSON request bodies (entries, session start). Separate from
 * `maxUploadBytes` because JSON is buffered in memory before parsing, while
 * media is streamed to disk. 256 KiB fits roughly an hour of transcribed
 * speech, far more than any real entry.
 */
export const MAX_JSON_BYTES = 256 * 1024;

/** Longest accepted session title. Titles end up in an H1, so keep them sane. */
export const MAX_TITLE_LENGTH = 200;
