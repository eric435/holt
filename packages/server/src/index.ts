/**
 * Public API of `nitpick-notes`.
 *
 * Most people only use the CLI (`npx nitpick`) or the Vite plugin
 * (`nitpick-notes/vite`). This entry is for mounting nitpick on some other
 * node:http-based dev server, or for scripting:
 *
 *   import { createNitpick } from "nitpick-notes";
 *   const nitpick = await createNitpick({ cwd: process.cwd() });
 *   server.on("request", async (req, res) => {
 *     if (await nitpick.handler(req, res)) return; // handled /__nitpick/*
 *     // ...your own routes
 *   });
 */
export { createNitpick, type CreateNitpickOptions, type Nitpick } from "./core.js";
export { startStandalone, type StandaloneOptions, type StandaloneServer } from "./adapters/standalone.js";
export { createHandler, type HandlerContext, type NitpickHandler } from "./http/handler.js";
export { loadConfig, type LoadConfigOptions, type LoadedConfig } from "./config/load.js";
export { validateConfig, ConfigError } from "./config/validate.js";
export type { NitpickConfig, ResolvedConfig } from "./config/types.js";
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
} from "@nitpick/protocol";
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
} from "@nitpick/protocol";
