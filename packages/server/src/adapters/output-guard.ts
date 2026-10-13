/**
 * Keeps Vite from serving the session folders.
 *
 * Vite's dev server serves any file under its root, so with the default
 * `outputDir: "qa"` inside the project, every screenshot and notes.md would
 * be readable at http://localhost:5173/qa/... by any page or script that
 * can reach the dev server. The Vite plugin mounts this check in front of
 * Vite's static middleware and answers 404 for any request that would land
 * inside outputDir.
 *
 * Getting "would land inside" right means thinking like the static server:
 *  - query strings and fragments are ignored (`/qa/x.png?raw`);
 *  - percent-encoding is decoded (`/%71a/x.png`, `/qa%2Fx.png`);
 *  - `..`, `.` and repeated slashes are normalized (`//qa/x`, `/a/../qa/x`);
 *  - backslashes count as separators (Windows);
 *  - Vite's special prefixes `/@fs/<absolute path>` and `/@id/<path>`;
 *  - `base` (served with the prefix stripped) and `publicDir` (served at /).
 * Comparison is case-insensitive, because macOS and Windows file systems
 * are, and blocking a little too much is the safe direction to be wrong in.
 * Anything that cannot be decoded is refused rather than guessed at.
 */
import path from "node:path";

export interface OutputGuardOptions {
  /** Absolute Vite root. */
  root: string;
  /** Absolute nitpick output directory. */
  outputDir: string;
  /** Absolute Vite publicDir, or empty/false if disabled. */
  publicDir?: string | false;
  /** Vite `base`, e.g. "/" or "/app/". */
  base?: string;
}

/** True if serving `rawUrl` could expose a file inside `outputDir`. */
export function requestTouchesOutputDir(rawUrl: string | undefined, options: OutputGuardOptions): boolean {
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
    files.push(path.join(options.root, p));
    if (options.publicDir) files.push(path.join(options.publicDir, p));
    const fsIndex = p.indexOf("/@fs/");
    if (fsIndex !== -1) files.push(path.resolve(p.slice(fsIndex + "/@fs".length)));
    if (p.startsWith("/@id/")) {
      const rest = p.slice("/@id".length);
      files.push(path.join(options.root, rest), path.resolve(rest));
    }
  }
  return files.some((file) => isInsideOrEqual(options.outputDir, file));
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

function isInsideOrEqual(dir: string, file: string): boolean {
  const rel = path.relative(dir.toLowerCase(), file.toLowerCase());
  return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}
