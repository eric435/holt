/**
 * Keeps Vite from serving holt's own files: the session folders and the
 * config file.
 *
 * Vite's dev server serves any file under its root, so with the default
 * `outputDir: "qa"` inside the project, every screenshot and notes.md would
 * be readable at http://localhost:5173/qa/... by any page or script that
 * can reach the dev server. The same goes for holt.config.json, which may
 * hold the token: Vite serves it at /holt.config.json (and as a JS module
 * at /holt.config.json?import), with `Access-Control-Allow-Origin` for
 * localhost origins. The Vite plugin mounts this check in front of Vite's
 * static middleware and answers 404 for any request that would land inside
 * outputDir or on one of the protected files (the config file that was
 * loaded, and <root>/holt.config.json even if it did not exist at startup,
 * since it can be created while the dev server runs).
 *
 * Getting "would land" right means thinking like the static server:
 *  - query strings and fragments are ignored (`/qa/x.png?raw`);
 *  - percent-encoding is decoded (`/%71a/x.png`, `/qa%2Fx.png`);
 *  - `..`, `.` and repeated slashes are normalized (`//qa/x`, `/a/../qa/x`);
 *  - backslashes count as separators (Windows);
 *  - Vite's special prefixes `/@fs/<absolute path>` and `/@id/<path>`. On
 *    Windows those look like `/@fs/C:/proj/qa/x.png`: the slash before the
 *    drive letter must go, or path.resolve reads it as a path on the
 *    current drive (`\C:\proj\...`) that is never inside `C:\proj\qa`;
 *  - on Windows, trailing dots and spaces in a name and `:stream` suffixes
 *    are ignored by the file system (`qa.\x.png`, `holt.config.json::$DATA`
 *    open the real thing), so they are stripped before comparing;
 *  - `base` (served with the prefix stripped) and `publicDir` (served at /).
 * Comparison is case-insensitive, because macOS and Windows file systems
 * are, and blocking a little too much is the safe direction to be wrong in.
 * Anything that cannot be decoded is refused rather than guessed at.
 *
 * `pathApi` exists for tests: passing `path.win32` checks the Windows rules
 * on any OS. The Vite plugin leaves it at the platform default.
 */
import path from "node:path";

export interface ProtectedPathOptions {
  /** Absolute Vite root. */
  root: string;
  /** Absolute holt output directory. Everything inside it is protected. */
  outputDir: string;
  /** Absolute paths of single files to protect (exact match, not a prefix). */
  protectedFiles?: string[];
  /** Absolute Vite publicDir, or empty/false if disabled. */
  publicDir?: string | false;
  /** Vite `base`, e.g. "/" or "/app/". */
  base?: string;
  /** Path implementation. Default: node:path for this platform. */
  pathApi?: path.PlatformPath;
}

/** True if serving `rawUrl` could expose a file inside `outputDir` or one of `protectedFiles`. */
export function requestTouchesProtectedPath(rawUrl: string | undefined, options: ProtectedPathOptions): boolean {
  const pathApi = options.pathApi ?? path;
  const pathname = extractPathname(rawUrl ?? "/");
  if (pathname === null) return true;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true; // malformed escape sequence: refuse
  }
  if (decoded.includes("\0")) return true;

  const urlPaths = new Set<string>();
  for (const p of [pathname, decoded]) {
    const normalized = path.posix.normalize(`/${p.replace(/\\/g, "/")}`);
    urlPaths.add(normalized);
    const base = options.base ?? "/";
    if (base !== "/" && normalized.startsWith(base)) urlPaths.add(`/${normalized.slice(base.length)}`);
  }

  const files: string[] = [];
  for (const p of urlPaths) {
    files.push(pathApi.join(options.root, p));
    if (options.publicDir) files.push(pathApi.join(options.publicDir, p));
    const fsIndex = p.indexOf("/@fs/");
    if (fsIndex !== -1) files.push(...absoluteCandidates(p.slice(fsIndex + "/@fs".length), pathApi));
    if (p.startsWith("/@id/")) {
      const rest = p.slice("/@id".length);
      files.push(pathApi.join(options.root, rest), ...absoluteCandidates(rest, pathApi));
    }
  }

  const canonical = files.map((file) => canonicalize(file, pathApi));
  const outputDir = canonicalize(options.outputDir, pathApi);
  const protectedFiles = (options.protectedFiles ?? []).map((file) => canonicalize(file, pathApi));
  return canonical.some(
    (file) => isInsideOrEqual(outputDir, file, pathApi) || protectedFiles.some((p) => pathApi.relative(p, file) === ""),
  );
}

/**
 * The file(s) an absolute URL path like "/C:/proj/x" or "/home/me/x" may
 * name. With a drive letter, both readings are kept: Windows needs the
 * slash dropped; elsewhere Vite does the same (and then reads "C:/..."
 * relative to the working directory), so either way blocking both is right.
 */
function absoluteCandidates(urlPath: string, pathApi: path.PlatformPath): string[] {
  const resolved = [pathApi.resolve(urlPath)];
  if (/^\/[a-zA-Z]:/.test(urlPath)) resolved.push(pathApi.resolve(urlPath.slice(1)));
  return resolved;
}

/**
 * Lowercase (see the header), and on Windows drop what the file system
 * ignores in each name: a trailing run of dots and spaces, and a
 * `:stream` suffix. The drive ("C:") is the first segment and kept.
 */
function canonicalize(file: string, pathApi: path.PlatformPath): string {
  const lower = file.toLowerCase();
  if (pathApi.sep !== "\\") return lower;
  return lower
    .split("\\")
    .map((segment, i) => (i === 0 ? segment : segment.replace(/:.*$/, "").replace(/[. ]+$/, "")))
    .join("\\");
}

/** The path part of a request target, without query or fragment. */
function extractPathname(raw: string): string | null {
  // Absolute-form targets ("GET http://host/qa/x HTTP/1.1") are legal HTTP.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      return new URL(raw).pathname;
    } catch {
      return null;
    }
  }
  // Deliberately not `new URL(raw, base)`: it would read "//qa/x" as a
  // host named "qa", while static servers read it as the path "/qa/x".
  return raw.split(/[?#]/, 1)[0] ?? "/";
}

function isInsideOrEqual(dir: string, file: string, pathApi: path.PlatformPath): boolean {
  const rel = pathApi.relative(dir, file);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel));
}
