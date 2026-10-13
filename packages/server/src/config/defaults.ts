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
} from "@holt/protocol";

export const DEFAULTS = {
  outputDir: DEFAULT_OUTPUT_DIR,
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  token: null,
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  sessionTitle: "QA session",
  allowedOrigins: [] as string[],
  allowedExtensionIds: [] as string[],
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

/**
 * Longest project name, in UTF-16 code units. Matches the protocol's
 * `ProjectInfo.name` limit: the extension shows it in one line of the panel.
 * (`projectName` has no entry in DEFAULTS: when unset, the name is derived
 * from package.json or the directory; see config/project.ts.)
 */
export const MAX_PROJECT_NAME_LENGTH = 100;

/**
 * Largest package.json we read to find the project name. Real ones are a
 * few KiB; anything bigger is skipped rather than buffered.
 */
export const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

/**
 * Most uploads that may wait for their entry within one session. The
 * extension posts the entry right after each upload, so a real client never
 * gets near this; it only stops a misbehaving one from filling the disk
 * with files that never appear in notes.md.
 */
export const MAX_PENDING_UPLOADS = 50;
