/**
 * Public API of `holt`.
 *
 * Most people only use the CLI (`npx holt`) or the Vite plugin
 * (`holt/vite`). This entry is for mounting holt on some other
 * node:http-based dev server, or for scripting:
 *
 *   import { createHolt } from "holt";
 *   const holt = await createHolt({ cwd: process.cwd() });
 *   server.on("request", async (req, res) => {
 *     if (await holt.handler(req, res)) return; // handled /__holt/*
 *     // ...your own routes
 *   });
 */
export { createHolt, type CreateHoltOptions, type Holt } from "./core.js";
export { startStandalone, type StandaloneOptions, type StandaloneServer } from "./adapters/standalone.js";
export { createHandler, type HandlerContext, type HoltHandler } from "./http/handler.js";
export { loadConfig, type LoadConfigOptions, type LoadedConfig } from "./config/load.js";
export { validateConfig, ConfigError } from "./config/validate.js";
export type { HoltConfig, ResolvedConfig } from "./config/types.js";
export { SessionStore, SessionError, type SessionStoreOptions } from "./session/store.js";
export { createConsoleLogger, silentLogger, type Logger } from "./log.js";
export { VERSION } from "./version.js";

// The wire protocol, so API users do not need the (private) protocol package.
export {
  BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  TOKEN_HEADER,
  KIND_HEADER,
  DEFAULT_PORT,
  DEFAULT_HOST,
  ACCEPTED_MEDIA_TYPES,
} from "@holt/protocol";
export type {
  Entry,
  EntryInput,
  EntryKind,
  PageContext,
  ScreenshotEntry,
  RecordingEntry,
  VoiceNoteEntry,
  NoteEntry,
  SessionInfo,
  ProjectInfo,
  StatusResponse,
  SessionResponse,
  MediaUploadResponse,
  EntryResponse,
  ErrorResponse,
  ErrorCode,
  ApiResponse,
} from "@holt/protocol";
