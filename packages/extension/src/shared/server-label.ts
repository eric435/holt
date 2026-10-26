/**
 * What the side panel's status line (and the toolbar menu's header) says
 * about the server (pure, unit-tested):
 *
 *   acme-web                                       <- project, prominent
 *   holt 0.1.0 · localhost:5173 · from this tab    <- muted detail
 *
 * The last part says how the server was picked (shared/server-resolve.ts):
 * "from this tab" (auto-detected on the page's origin), "fixed URL", or
 * "fallback (no holt on this page)".
 *
 * `project` is newer than the rest of the status response, so an older
 * server may not send it; we then show only the detail line. The value
 * comes from the server, i.e. from a package.json or config file, so it is
 * treated as plain text (rendered with textContent) and capped.
 */

/**
 * How the server for a tab was picked (shared/server-resolve.ts decides,
 * and re-exports this). Defined here, next to its labels, so that this
 * module imports nothing that touches chrome.*: the protocol contract test
 * (packages/server/src/http/extension-contract.test.ts) runs it in Node.
 */
export type ServerSource = "tab" | "fixed" | "fallback";

const MAX_PROJECT_NAME = 100;

export interface StatusLike {
  version?: unknown;
  protocolVersion?: unknown;
  project?: unknown;
}

export interface ServerLabel {
  project: string | null;
  detail: string;
}

export function serverLabel(status: StatusLike, serverUrl: string, source?: ServerSource): ServerLabel {
  const version = typeof status.version === "string" && status.version ? ` ${status.version}` : "";
  const how = source ? ` · ${sourceLabel(source)}` : "";
  return { project: projectName(status), detail: `holt${version} · ${displayHost(serverUrl)}${how}` };
}

/** How the server was picked, in a few words. */
export function sourceLabel(source: ServerSource): string {
  switch (source) {
    case "tab":
      return "from this tab";
    case "fixed":
      return "fixed URL";
    case "fallback":
      return "fallback (no holt on this page)";
  }
}

export function projectName(status: StatusLike): string | null {
  const project = status.project;
  if (typeof project !== "object" || project === null) return null;
  const name = (project as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, MAX_PROJECT_NAME) : null;
}

/** "http://127.0.0.1:4848" -> "127.0.0.1:4848". https:// is kept: it is worth seeing. */
export function displayHost(serverUrl: string): string {
  return serverUrl.replace(/^http:\/\//i, "").replace(/\/+$/, "");
}
