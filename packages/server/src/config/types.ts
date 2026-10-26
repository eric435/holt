/**
 * Configuration types.
 *
 * `HoltConfig` is what a user writes (every key optional): the shape of
 * holt.config.json, Vite plugin options, and CLI flags.
 * `ResolvedConfig` is what the rest of the server works with: every key
 * filled in, paths made absolute. Keeping the two separate means no code
 * past the loader ever has to ask "was this set?".
 */
import type { ProjectInfo } from "@holt/protocol";

export interface HoltConfig {
  /** Where session folders are written, relative to the project root. */
  outputDir?: string;
  /** Port for the standalone server. Ignored by the Vite plugin. */
  port?: number;
  /** Interface the standalone server binds to. Keep it on loopback. Ignored by the Vite plugin. */
  host?: string;
  /**
   * Optional shared secret the extension must send in `x-holt-token`.
   * Also read from the HOLT_TOKEN environment variable, which is the better
   * place for it than a committed holt.config.json (config/load.ts).
   */
  token?: string | null;
  /** Upper limit for a single media upload, in bytes. */
  maxUploadBytes?: number;
  /** Default H1 title for new sessions. */
  sessionTitle?: string;
  /**
   * Name the extension shows for this project. Default: the `name` in
   * <root>/package.json, else the root directory's name.
   */
  projectName?: string;
  /**
   * Extra web origins (besides any `chrome-extension://` origin) allowed to
   * call the API, e.g. "http://localhost:3000". Exact origins only, no wildcards.
   */
  allowedOrigins?: string[];
  /**
   * Chrome extension IDs (32 letters a-p) allowed to call the API. Empty
   * (the default) allows any chrome-extension:// origin; set this to pin
   * holt to your installed copy of the extension.
   */
  allowedExtensionIds?: string[];
}

export interface ResolvedConfig {
  /** Absolute project root. Relative paths in the config resolve against it. */
  root: string;
  /** Absolute path of the output directory. */
  outputDir: string;
  port: number;
  host: string;
  token: string | null;
  maxUploadBytes: number;
  sessionTitle: string;
  /**
   * Who this server is writing for, resolved once at startup from
   * `projectName`, package.json, or the directory name (config/project.ts).
   * Replaces `projectName`: nothing downstream needs the raw option.
   */
  project: ProjectInfo;
  allowedOrigins: string[];
  allowedExtensionIds: string[];
  /** Absolute path of the config file that was loaded, or null if none. */
  configFile: string | null;
}
