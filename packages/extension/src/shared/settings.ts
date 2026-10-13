/**
 * User settings: where the server is, the optional shared token, and whether
 * voice notes keep their audio file.
 *
 * Storage choice:
 *  - `chrome.storage.sync`  for serverUrl + keepAudio: harmless preferences;
 *    syncing them across the user's Chrome profiles is a convenience.
 *  - `chrome.storage.local` for the token: it is a secret and should not be
 *    uploaded to the user's Google account by Chrome Sync.
 *
 * Both storage areas are reachable from the worker and the side panel (but
 * not from content scripts unless we opt in, which we don't).
 *
 * The validation functions at the top are pure so they can be unit-tested.
 */

import { BASE_PATH, DEFAULT_HOST, DEFAULT_PORT } from "@nitpick/protocol";

export const DEFAULT_SERVER_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

export interface Settings {
  /** Origin of the nitpick server (standalone CLI or the Vite dev server). */
  serverUrl: string;
  /** Shared secret; empty string means "no token". */
  token: string;
  /** Upload the audio of voice notes, not just the transcript. */
  keepAudio: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  serverUrl: DEFAULT_SERVER_URL,
  token: "",
  keepAudio: true,
};

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

export type ServerUrlValidation =
  | { ok: true; url: string; warning?: string }
  | { ok: false; error: string };

/**
 * Loopback hosts. The manifest's host_permissions only cover 127.0.0.1 and
 * localhost, and SECURITY.md assumes the server is not exposed on the
 * network, so anything else gets a warning (but is allowed: someone may run
 * the server in a VM or container on purpose).
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Normalise and validate what the user typed as the server URL.
 *
 * Accepted: an http(s) origin such as `http://127.0.0.1:4848` or
 * `http://localhost:5173` (Vite plugin mode). A trailing slash or a trailing
 * `/__nitpick` is tolerated and stripped, since people will paste either.
 * The result is always a bare origin; api.ts appends BASE_PATH.
 */
export function validateServerUrl(raw: string): ServerUrlValidation {
  const input = raw.trim();
  if (input === "") return { ok: false, error: "Server URL is empty." };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: `"${input}" is not a valid URL. Example: ${DEFAULT_SERVER_URL}` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `Server URL must start with http:// or https:// (got ${url.protocol}).` };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Server URL must not contain a user name or password. Use the token field instead." };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "Server URL must not contain a query string or #fragment." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== BASE_PATH) {
    return {
      ok: false,
      error: `Server URL should be just the origin (e.g. ${DEFAULT_SERVER_URL}), not a path like "${url.pathname}".`,
    };
  }

  if (isLoopbackHost(url.hostname)) return { ok: true, url: url.origin };
  return {
    ok: true,
    url: url.origin,
    warning:
      `${url.hostname} is not a loopback address. nitpick is meant to run on your machine only; ` +
      "the extension's network permission covers 127.0.0.1 and localhost, so other hosts only work if " +
      "the server allows this extension's origin via CORS.",
  };
}

/** Fill in defaults and drop junk from whatever was in storage. */
export function normalizeSettings(stored: Partial<Record<keyof Settings, unknown>>): Settings {
  const validated = typeof stored.serverUrl === "string" ? validateServerUrl(stored.serverUrl) : null;
  return {
    serverUrl: validated?.ok ? validated.url : DEFAULT_SETTINGS.serverUrl,
    token: typeof stored.token === "string" ? stored.token.trim() : DEFAULT_SETTINGS.token,
    keepAudio: typeof stored.keepAudio === "boolean" ? stored.keepAudio : DEFAULT_SETTINGS.keepAudio,
  };
}

// ---------------------------------------------------------------------------
// Storage (thin wrappers over chrome.storage)
// ---------------------------------------------------------------------------

const SYNC_KEYS = ["serverUrl", "keepAudio"] as const;
const LOCAL_KEYS = ["token"] as const;

export async function loadSettings(): Promise<Settings> {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get([...SYNC_KEYS]),
    chrome.storage.local.get([...LOCAL_KEYS]),
  ]);
  return normalizeSettings({ ...synced, ...local });
}

/** Persist a partial update. Throws if serverUrl is invalid. */
export async function saveSettings(update: Partial<Settings>): Promise<Settings> {
  const syncPatch: Record<string, unknown> = {};
  const localPatch: Record<string, unknown> = {};
  if (update.serverUrl !== undefined) {
    const v = validateServerUrl(update.serverUrl);
    if (!v.ok) throw new Error(v.error);
    syncPatch.serverUrl = v.url;
  }
  if (update.keepAudio !== undefined) syncPatch.keepAudio = update.keepAudio;
  if (update.token !== undefined) localPatch.token = update.token.trim();
  await Promise.all([
    Object.keys(syncPatch).length ? chrome.storage.sync.set(syncPatch) : undefined,
    Object.keys(localPatch).length ? chrome.storage.local.set(localPatch) : undefined,
  ]);
  return loadSettings();
}

/** Call `listener` whenever any setting changes (in any context). */
export function onSettingsChanged(listener: () => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    const keys: readonly string[] = area === "sync" ? SYNC_KEYS : area === "local" ? LOCAL_KEYS : [];
    if (Object.keys(changes).some((k) => keys.includes(k))) listener();
  });
}
