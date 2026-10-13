/**
 * Configuration types.
 *
 * `NitpickConfig` is what a user writes (every key optional): the shape of
 * nitpick.config.json, Vite plugin options, and CLI flags.
 * `ResolvedConfig` is what the rest of the server works with: every key
 * filled in, paths made absolute. Keeping the two separate means no code
 * past the loader ever has to ask "was this set?".
 */
export interface NitpickConfig {
  /** Where session folders are written, relative to the project root. */
  outputDir?: string;
  /** Port for the standalone server. Ignored by the Vite plugin. */
  port?: number;
  /** Interface the standalone server binds to. Keep it on loopback. */
  host?: string;
  /** Optional shared secret the extension must send in `x-nitpick-token`. */
  token?: string | null;
  /** Upper limit for a single media upload, in bytes. */
  maxUploadBytes?: number;
  /** Default H1 title for new sessions. */
  sessionTitle?: string;
  /**
   * Extra web origins (besides any `chrome-extension://` origin) allowed to
   * call the API, e.g. "http://localhost:3000". Exact origins only, no wildcards.
   */
  allowedOrigins?: string[];
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
  allowedOrigins: string[];
  /** Absolute path of the config file that was loaded, or null if none. */
  configFile: string | null;
}
