/**
 * Which holt server a capture on a given tab goes to (pure, unit-tested;
 * shared/server.ts wires it to chrome.* and the API client).
 *
 * Why auto-detect: in Vite-plugin mode the server IS the page's origin
 * (`http://localhost:5173/__holt/...`), so asking users to type that URL
 * into the settings is busywork, and wrong as soon as they run a second
 * project on another port. So, in "auto" mode (the default):
 *
 *   tab URL is http://localhost:<port> or http://127.0.0.1:<port>
 *     and GET <origin>/__holt/status answers as holt  -> that origin  ("tab")
 *     doesn't answer, but has answered as holt before -> an error, see below
 *   anything else                                     -> settings.serverUrl ("fallback")
 *
 * and in "fixed" mode always settings.serverUrl ("fixed"), without probing.
 *
 * Rules that keep this safe and cheap:
 *  - Only origins on this machine that our host_permissions cover are ever
 *    probed: http on `localhost` and `127.0.0.1` (manifest.json, any port).
 *    SECURITY.md assumes holt is on this machine; a page on any other host
 *    never makes us talk to it (or send it the user's captures). Other
 *    loopback spellings (`*.localhost`, `[::1]`, `127.0.0.2`, https) are
 *    loopback too, but on those tabs the worker can't read the URL without
 *    a host permission, and the extension can't fetch from them either, so
 *    probing them could never work; they use the fallback.
 *  - An origin that has answered as holt once (since the browser started:
 *    `holtOrigins` in storage.session) never falls back. Its probe failing
 *    (1.5 s timeout, the dev server restarting, a crash) is reported as an
 *    error instead: falling back would quietly send this page's capture to
 *    the fixed URL's server, which may be another project's, i.e. write
 *    into the wrong repository.
 *  - The probe is `createApi(...).status()` with a short timeout, and only
 *    a holt body counts (`ok: true, name: "holt"`), so some other app's
 *    `/__holt/status` (or a catch-all that answers every path with 200 and
 *    HTML) is not mistaken for holt. See shared/server.ts for the probe
 *    itself and why it does not send the token.
 *  - Results are cached per origin (positive 15 s, negative 5 s) in
 *    storage.session, so a burst of actions (screenshot, then its note
 *    prompt, then the panel's poll) probes once, and a server that was just
 *    started or stopped is noticed within seconds.
 */

import type { StatusResponse } from "@holt/protocol";
import type { ServerSource } from "./server-label.js";
import { isLoopbackHost, type Settings } from "./settings.js";

export type { ServerSource };

export interface ResolvedServer {
  /** Bare origin of the server to use. */
  serverUrl: string;
  source: ServerSource;
  /** The status the probe just got, if it probed and succeeded (saves the caller a second GET /status). */
  status?: StatusResponse;
}

/** What one probe found out about an origin. */
export interface ProbeCacheEntry {
  ok: boolean;
  /** When it was probed (epoch ms). */
  at: number;
}

/** Probe results by origin, kept in storage.session (`serverProbes`). */
export type ProbeCache = Record<string, ProbeCacheEntry>;

export interface ProbeCacheStore {
  get(origin: string): Promise<ProbeCacheEntry | undefined>;
  set(origin: string, entry: ProbeCacheEntry): Promise<void>;
  /** Has `origin` answered as holt since the browser started? */
  wasHolt(origin: string): Promise<boolean>;
  /** Remember that `origin` answered as holt. */
  markHolt(origin: string): Promise<void>;
}

/** The page's own holt server, which answered before, doesn't now (see the header): no fallback. */
export class HoltNotAnsweringError extends Error {
  override readonly name = "HoltNotAnsweringError";
  constructor(readonly serverUrl: string) {
    super(`holt on ${serverUrl} isn't answering (dev server restarting?). Try again in a moment.`);
  }
}

/** The hosts our host_permissions cover (manifest.json): the only ones probed. */
const PROBED_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/**
 * Probe `origin` for holt. Resolves with the status when it is holt, with
 * `true` when it is holt but did not hand out its status (it wants a token,
 * see shared/server.ts), and with null when it is not holt or did not answer.
 */
export type Probe = (origin: string) => Promise<StatusResponse | true | null>;

export const PROBE_TTL_OK_MS = 15_000;
export const PROBE_TTL_FAILED_MS = 5_000;
export const PROBE_TIMEOUT_MS = 1_500;

export interface ResolveInput {
  /** The tab's URL, if we can read it (loopback tabs: host_permissions; others: only with activeTab). */
  tabUrl: string | undefined;
  settings: Pick<Settings, "serverMode" | "serverUrl">;
  probe: Probe;
  cache: ProbeCacheStore;
  /** Epoch ms. */
  now: number;
}

export async function resolveServer({ tabUrl, settings, probe, cache, now }: ResolveInput): Promise<ResolvedServer> {
  if (settings.serverMode === "fixed") return { serverUrl: settings.serverUrl, source: "fixed" };
  const fallback: ResolvedServer = { serverUrl: settings.serverUrl, source: "fallback" };

  const origin = probeableOrigin(tabUrl);
  if (!origin) return fallback;

  const cached = await cache.get(origin);
  if (cached && isFresh(cached, now)) {
    if (cached.ok) return { serverUrl: origin, source: "tab" };
    return notHolt(origin, fallback, cache);
  }

  let found: StatusResponse | true | null;
  try {
    found = await probe(origin);
  } catch {
    found = null;
  }
  await cache.set(origin, { ok: found !== null, at: now });
  if (found === null) return notHolt(origin, fallback, cache);
  await cache.markHolt(origin);
  return found === true ? { serverUrl: origin, source: "tab" } : { serverUrl: origin, source: "tab", status: found };
}

/** `origin` is not answering as holt: the fallback, unless it used to be holt (see the header). */
async function notHolt(origin: string, fallback: ResolvedServer, cache: ProbeCacheStore): Promise<ResolvedServer> {
  if (await cache.wasHolt(origin)) throw new HoltNotAnsweringError(origin);
  return fallback;
}

/**
 * The origin to probe for `tabUrl`, or null if we must not: anything that
 * is not an http page on a host our host_permissions cover (chrome:// pages,
 * file://, the extension's own pages, every site on the network or the
 * internet, and the loopback spellings we have no permission for).
 */
export function probeableOrigin(tabUrl: string | undefined): string | null {
  if (!tabUrl) return null;
  let url: URL;
  try {
    url = new URL(tabUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  // isLoopbackHost too, as a second line: never probe anything off this machine.
  if (!PROBED_HOSTS.has(url.hostname) || !isLoopbackHost(url.hostname)) return null;
  return url.origin;
}

/** The origins in `list` plus `origin` (a set kept as an array in storage.session). Pure. */
export function addHoltOrigin(list: readonly string[], origin: string): string[] {
  return list.includes(origin) ? [...list] : [...list, origin];
}

/** Is `tabUrl` a page on this machine (where holt is used, and where auto-detection applies)? */
export function isLocalPage(tabUrl: string | undefined): boolean {
  return probeableOrigin(tabUrl) !== null;
}

export function isFresh(entry: ProbeCacheEntry, now: number): boolean {
  const age = now - entry.at;
  return age >= 0 && age < (entry.ok ? PROBE_TTL_OK_MS : PROBE_TTL_FAILED_MS);
}

/** The cache with `origin` set to `entry` and everything stale dropped (so it never grows). */
export function updateProbeCache(cache: ProbeCache, origin: string, entry: ProbeCacheEntry, now: number): ProbeCache {
  const next: ProbeCache = {};
  for (const [key, value] of Object.entries(cache)) if (isFresh(value, now)) next[key] = value;
  next[origin] = entry;
  return next;
}
