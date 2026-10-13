/**
 * What the status line says about the server (pure, unit-tested):
 *
 *   acme-web                         <- project, prominent
 *   holt 0.1.0 · 127.0.0.1:4848   <- muted detail
 *
 * `project` is newer than the rest of the status response, so an older
 * server may not send it; we then show only the detail line. The value
 * comes from the server, i.e. from a package.json or config file, so it is
 * treated as plain text (rendered with textContent) and capped.
 */

const MAX_PROJECT_NAME = 100;

export interface StatusLike {
  version?: unknown;
  project?: unknown;
}

export interface ServerLabel {
  project: string | null;
  detail: string;
}

export function serverLabel(status: StatusLike, serverUrl: string): ServerLabel {
  const version = typeof status.version === "string" && status.version ? ` ${status.version}` : "";
  return { project: projectName(status), detail: `holt${version} · ${displayHost(serverUrl)}` };
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
