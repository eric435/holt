/**
 * "Which holt server does a capture on this tab go to?", wired to Chrome:
 * the pure decision is shared/server-resolve.ts; this file adds the probe
 * (an API client's GET /status), the probe cache in storage.session
 * (`serverProbes`, and `holtOrigins`: the origins that have been holt), and
 * API clients for a resolved or pinned server.
 *
 * Resolving can throw (HoltNotAnsweringError, see server-resolve.ts) when the
 * page's own holt server, which answered before, doesn't now; callers report
 * it like any other server error.
 *
 * Used by the worker (captures, recordings, the toolbar's connectivity
 * state in background/server-info.ts), the side panel (its status line and
 * session buttons) and the note page (as a fallback when the worker has not
 * resolved the quick note's server yet). All of them are trusted extension
 * contexts with storage.session and our host permissions.
 *
 * The probe sends the client header but NOT the token: the token is a
 * secret for the holt server, and auto-detection asks every loopback origin
 * the user visits (a Rails app on :3000, someone else's dev server) whether
 * it is holt. A holt server that requires a token answers the token-less
 * probe with its own `forbidden` error body, which is enough to know holt
 * is there; the real requests then carry the token, and a wrong token shows
 * up as that server's error, not as a silent fallback.
 *
 * Captures also check that the server speaks our protocol version
 * (`assertCompatible`, shared/protocol-compat.ts) before they start, so a
 * server from another release is refused up front with a message saying
 * which side to update.
 */

import type { StatusResponse } from "@holt/protocol";
import { ApiError, createApi, isHoltStatus, type Api, type ApiConfig } from "./api.js";
import { protocolCompatibility } from "./protocol-compat.js";
import { PROBE_TIMEOUT_MS, addHoltOrigin, resolveServer, updateProbeCache, type ProbeCacheStore, type ResolvedServer, type ServerSource } from "./server-resolve.js";
import { loadSettings, type Settings } from "./settings.js";
import { getState, setState } from "./state.js";

/** The subset of chrome.tabs.Tab we read. */
export interface TabUrlLike {
  url?: string | undefined;
  pendingUrl?: string | undefined;
}

export type ResolvedApi = Api & { serverUrl: string; source: ServerSource };

/** The server for a capture on `tab` (undefined: no tab, so the fixed/fallback URL). */
export async function resolveServerForTab(tab: TabUrlLike | undefined, settings?: Settings): Promise<ResolvedServer> {
  return resolveServerForUrl(tab?.url || tab?.pendingUrl, settings);
}

export async function resolveServerForUrl(tabUrl: string | undefined, settings?: Settings): Promise<ResolvedServer> {
  return resolveServer({ tabUrl, settings: settings ?? (await loadSettings()), probe, cache: sessionCache, now: Date.now() });
}

/**
 * An API client for the server of `tab`, with the token from the settings,
 * for a capture: refuses (throws) a server that speaks another protocol
 * version, see `assertCompatible`.
 */
export async function apiForTab(tab: TabUrlLike | undefined): Promise<ResolvedApi> {
  const settings = await loadSettings();
  const { serverUrl, source } = await compatibleServerForTab(tab, settings);
  return { ...createApi({ serverUrl, token: settings.token }), serverUrl, source };
}

/** `resolveServerForTab`, then `assertCompatible`: the server a capture on `tab` may go to. */
export async function compatibleServerForTab(tab: TabUrlLike | undefined, settings?: Settings): Promise<ResolvedServer> {
  const current = settings ?? (await loadSettings());
  const resolved = await resolveServerForTab(tab, current);
  await assertCompatible(resolved, current.token);
  return resolved;
}

/**
 * Throw an ApiError("incompatible") with the message to show if the server
 * speaks another protocol version than this extension
 * (shared/protocol-compat.ts). Uses the status the probe just fetched if
 * there is one, else GET /status with the token: one loopback request
 * before a capture, so that it refuses before the user records, drags or
 * types anything, rather than with a 400 afterwards.
 *
 * Only a server that answered with another version is refused here. If the
 * status request itself fails (not running yet, wrong token), the capture
 * goes ahead exactly as it did before this check existed, and its own
 * request reports that error: a recording may be started before the
 * server, and a voice note without microphone access must still get to
 * the "grant access" offer.
 */
export async function assertCompatible(server: { serverUrl: string; status?: StatusResponse | undefined }, token: string): Promise<void> {
  let status: StatusResponse;
  try {
    status = server.status ?? (await createApi({ serverUrl: server.serverUrl, token }).status());
  } catch {
    return;
  }
  const compatibility = protocolCompatibility(status, server.serverUrl);
  if (!compatibility.ok) throw new ApiError("incompatible", compatibility.message);
}

/**
 * `apiForServer` for a capture (a quick note): refuses a server that speaks
 * another protocol version, see `assertCompatible`.
 */
export async function compatibleApiForServer(serverUrl: string): Promise<Api & { serverUrl: string }> {
  const { token } = await loadSettings();
  await assertCompatible({ serverUrl }, token);
  return { ...createApi({ serverUrl, token }), serverUrl };
}

/** An API client for a server picked earlier (a pending screenshot's, a quick note's). */
export async function apiForServer(serverUrl: string): Promise<Api & { serverUrl: string }> {
  const { token } = await loadSettings();
  return { ...createApi({ serverUrl, token }), serverUrl };
}

/**
 * A client for the fixed/fallback URL from the current settings (no
 * auto-detection: `apiForTab` is "the server for this tab"). Settings are
 * read from storage on every call (cheap), because the worker may have
 * been restarted since the last call and the user may have changed them in
 * the panel. Pass `config` to skip storage.
 */
export async function getApi(config?: ApiConfig): Promise<Api & { serverUrl: string }> {
  const settings = config ?? (await loadSettings());
  return { ...createApi(settings), serverUrl: settings.serverUrl };
}

/** Is holt at `origin`? See the header for why the token is not sent. */
async function probe(origin: string): Promise<StatusResponse | true | null> {
  try {
    const status = await createApi({ serverUrl: origin, token: "" }).status({ timeoutMs: PROBE_TIMEOUT_MS });
    return isHoltStatus(status) ? status : null;
  } catch (error) {
    // holt's own error body, e.g. "Missing or wrong x-holt-token header".
    if (error instanceof ApiError && error.code === "forbidden") return true;
    return null;
  }
}

/**
 * The probe cache in storage.session. A broken cache only costs extra
 * probes (or, for `holtOrigins`, the fallback the known-origin rule exists
 * to avoid, which is what happened before there was such a rule).
 */
const sessionCache: ProbeCacheStore = {
  async get(origin) {
    try {
      return (await getState("serverProbes"))?.[origin];
    } catch {
      return undefined;
    }
  },
  async set(origin, entry) {
    try {
      await setState("serverProbes", updateProbeCache((await getState("serverProbes")) ?? {}, origin, entry, Date.now()));
    } catch {
      /* see above */
    }
  },
  async wasHolt(origin) {
    try {
      return ((await getState("holtOrigins")) ?? []).includes(origin);
    } catch {
      return false;
    }
  },
  async markHolt(origin) {
    try {
      const known = (await getState("holtOrigins")) ?? [];
      if (!known.includes(origin)) await setState("holtOrigins", addHoltOrigin(known, origin));
    } catch {
      /* see above */
    }
  },
};
