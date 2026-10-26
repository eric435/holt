/**
 * User settings: how to find the server (auto-detect from the page, or one
 * fixed URL), the fixed/fallback server URL, the optional shared token,
 * whether speech is transcribed at all, whether voice notes keep their
 * audio file, which microphone to record from, and one UI flag (the
 * shortcut hint was dismissed).
 *
 * Storage: everything lives in `chrome.storage.local` (this device only).
 *  - Not `storage.sync`: a server URL synced to another of the user's
 *    machines could point that machine at an address that means something
 *    else there (or at a stranger's IP), and the token is a secret that
 *    shouldn't be uploaded to the user's Google account. (A development
 *    build kept serverUrl/keepAudio in sync for a few minutes before any
 *    release; nothing was ever published that wrote there, so there is no
 *    migration.)
 *  - Who can read it: by default `storage.local` and `storage.sync` are
 *    readable by our content scripts too, i.e. from inside web pages. The
 *    worker restricts both to trusted contexts (worker + extension pages)
 *    at startup with `setAccessLevel`, see `restrictStorageAccess`, so a
 *    compromised page renderer can't read the token or repoint serverUrl.
 *    Our content scripts never need settings.
 *
 * The validation and normalising functions are pure so they can be
 * unit-tested.
 */

import { BASE_PATH, DEFAULT_HOST, DEFAULT_PORT } from "@holt/protocol";

export const DEFAULT_SERVER_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

/**
 * How the extension picks the server for a capture (shared/server-resolve.ts):
 *  - "auto": if the page being captured is served from a loopback origin
 *    that answers `GET /__holt/status` as holt (the Vite plugin), use that
 *    origin; otherwise use `serverUrl`.
 *  - "fixed": always use `serverUrl`, never probe.
 */
export type ServerMode = "auto" | "fixed";

export interface Settings {
  serverMode: ServerMode;
  /**
   * Origin of the holt server (standalone CLI or a dev server with the Vite
   * plugin): the only server in "fixed" mode, the fallback in "auto" mode.
   */
  serverUrl: string;
  /** Shared secret; empty string means "no token". */
  token: string;
  /**
   * Transcribe speech live with Chrome's speech recognition
   * (shared/speech.ts): voice notes, the narration of tab recordings, and
   * dictation in the note window. In Chrome that recogniser streams the
   * microphone audio to Google's speech service, which is why it can be
   * turned off. Off: no recogniser is ever created. Voice notes then keep
   * their audio file whatever `keepAudio` says (see `keepsVoiceAudio`),
   * tab recordings don't open the microphone at all (it is only there for
   * the transcript), and the note window has no dictation button. On by
   * default (the behaviour before this setting existed).
   */
  transcribe: boolean;
  /**
   * Upload the audio of voice notes, not just the reviewed transcript. Off
   * by default: the words are what goes into notes.md, and the audio is
   * kept anyway when recognition produced nothing usable, and always while
   * `transcribe` is off (`keepsVoiceAudio`). The stored value is the user's
   * choice for when transcription is on; it is not changed by turning
   * transcription off.
   */
  keepAudio: boolean;
  /**
   * `deviceId` from navigator.mediaDevices.enumerateDevices() of the
   * microphone to record voice notes with; "" means the system default.
   * Device ids are per origin (chrome-extension://<id>), and the side panel
   * that lists them and the offscreen document that records share that
   * origin, so an id picked in the panel is valid in the recorder.
   */
  microphoneId: string;
  /** The device's label when it was picked, for display ("" if unknown). */
  microphoneLabel: string;
  /** The user dismissed the "set the remaining shortcuts" hint in the panel. */
  hideShortcutHint: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  serverMode: "auto",
  serverUrl: DEFAULT_SERVER_URL,
  token: "",
  transcribe: true,
  keepAudio: false,
  microphoneId: "",
  microphoneLabel: "",
  hideShortcutHint: false,
};

/** Device ids are opaque ~64-char hashes; anything far longer is junk. */
const MAX_DEVICE_ID_LENGTH = 512;
const MAX_DEVICE_LABEL_LENGTH = 200;

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
 * `/__holt` is tolerated and stripped, since people will paste either.
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
      `${url.hostname} is not a loopback address. holt is meant to run on your machine only; ` +
      "the extension's network permission covers 127.0.0.1 and localhost, so other hosts only work if " +
      "the server allows this extension's origin via CORS.",
  };
}

/** Fill in defaults and drop junk from whatever was in storage. */
export function normalizeSettings(stored: Partial<Record<keyof Settings, unknown>>): Settings {
  const validated = typeof stored.serverUrl === "string" ? validateServerUrl(stored.serverUrl) : null;
  return {
    serverMode: isServerMode(stored.serverMode) ? stored.serverMode : DEFAULT_SETTINGS.serverMode,
    serverUrl: validated?.ok ? validated.url : DEFAULT_SETTINGS.serverUrl,
    token: typeof stored.token === "string" ? stored.token.trim() : DEFAULT_SETTINGS.token,
    // Only an explicit `false` turns it off: a missing or junk value (every
    // install from before this setting) keeps transcribing, as it did.
    transcribe: stored.transcribe !== false,
    keepAudio: typeof stored.keepAudio === "boolean" ? stored.keepAudio : DEFAULT_SETTINGS.keepAudio,
    ...normalizeMicrophone(stored.microphoneId, stored.microphoneLabel),
    hideShortcutHint: stored.hideShortcutHint === true,
  };
}

/**
 * Does a voice note upload its audio file? Yes if the user asked for it
 * (`keepAudio`), if transcription is off (then the audio is the voice
 * note: words typed into the box on the page are kept as its note, but
 * they are not what was said), and whenever there are no words to save
 * (`note` is the reviewed transcript), or the voice note would be empty.
 */
export function keepsVoiceAudio(settings: Pick<Settings, "keepAudio" | "transcribe">, note: string): boolean {
  return settings.keepAudio || keepAudioForced(settings) || note.trim() === "";
}

/** The keep-audio setting doesn't apply right now: voice notes keep their audio regardless (the UI shows it checked and disabled). */
export function keepAudioForced(settings: Pick<Settings, "transcribe">): boolean {
  return !settings.transcribe;
}

export function isServerMode(value: unknown): value is ServerMode {
  return value === "auto" || value === "fixed";
}

/**
 * Microphone choice from storage. An id is only kept if it is a sane string;
 * the label is display-only and is dropped together with an invalid id (a
 * label without an id would claim a device we don't use).
 */
export function normalizeMicrophone(id: unknown, label: unknown): Pick<Settings, "microphoneId" | "microphoneLabel"> {
  if (typeof id !== "string" || id.length > MAX_DEVICE_ID_LENGTH || id.trim() === "" || id === "default") {
    // "default" is Chrome's alias for the system default device: same as "".
    return { microphoneId: "", microphoneLabel: "" };
  }
  const cleanLabel = typeof label === "string" ? label.trim().slice(0, MAX_DEVICE_LABEL_LENGTH) : "";
  return { microphoneId: id, microphoneLabel: cleanLabel };
}

// ---------------------------------------------------------------------------
// Access level (called by the worker at startup)
// ---------------------------------------------------------------------------

/**
 * Restrict storage.local and storage.sync to trusted contexts (worker and
 * extension pages), so content scripts can't read the token or change the
 * server URL. storage.sync is unused, but restricting it costs nothing and
 * means a future use can't start out readable from web pages.
 * storage.session is already restricted by default. Failures
 * (an older Chrome without support for an area) are logged, not fatal.
 */
export async function restrictStorageAccess(): Promise<void> {
  const areas = [
    ["local", chrome.storage.local],
    ["sync", chrome.storage.sync],
  ] as const;
  await Promise.all(
    areas.map(async ([name, area]) => {
      try {
        await area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      } catch (error) {
        console.warn(`[holt] could not restrict chrome.storage.${name} to trusted contexts`, error);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Storage (thin wrappers over chrome.storage.local)
// ---------------------------------------------------------------------------

const KEYS = ["serverMode", "serverUrl", "token", "transcribe", "keepAudio", "microphoneId", "microphoneLabel", "hideShortcutHint"] as const;

export async function loadSettings(): Promise<Settings> {
  return normalizeSettings(await chrome.storage.local.get([...KEYS]));
}

/** Persist a partial update. Throws if serverUrl or serverMode is invalid. */
export async function saveSettings(update: Partial<Settings>): Promise<Settings> {
  const patch: Record<string, unknown> = {};
  if (update.serverMode !== undefined) {
    if (!isServerMode(update.serverMode)) throw new Error(`Unknown server mode "${String(update.serverMode)}".`);
    patch.serverMode = update.serverMode;
  }
  if (update.serverUrl !== undefined) {
    const v = validateServerUrl(update.serverUrl);
    if (!v.ok) throw new Error(v.error);
    patch.serverUrl = v.url;
  }
  if (update.keepAudio !== undefined) patch.keepAudio = update.keepAudio;
  if (update.transcribe !== undefined) patch.transcribe = update.transcribe;
  if (update.token !== undefined) patch.token = update.token.trim();
  // "" (or junk) selects the system default and clears the label.
  if (update.microphoneId !== undefined) Object.assign(patch, normalizeMicrophone(update.microphoneId, update.microphoneLabel ?? ""));
  if (update.hideShortcutHint !== undefined) patch.hideShortcutHint = update.hideShortcutHint;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  return loadSettings();
}

/** Call `listener` whenever any setting changes (in any context). */
export function onSettingsChanged(listener: () => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some((k) => (KEYS as readonly string[]).includes(k))) listener();
  });
}
