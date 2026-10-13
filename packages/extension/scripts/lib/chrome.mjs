/**
 * Shared helpers for driving a real Chrome with the extension loaded, used by
 * smoke.mjs and e2e.mjs. No dependencies: Node 22's global WebSocket speaks
 * the Chrome DevTools Protocol (CDP) directly.
 *
 *   launchChrome()    fresh temp profile, --remote-debugging-port=0 (Chrome
 *                     picks a port and writes it to <profile>/DevToolsActivePort)
 *   Cdp               a minimal CDP client with flattened sessions
 *   loadExtension()   attach to service workers paused at startup (so errors
 *                     thrown while background.js first runs are not missed),
 *                     then load dist/. `--load-extension` is passed at launch,
 *                     but branded Google Chrome ignores it since v137, so we
 *                     fall back to the CDP command Extensions.loadUnpacked
 *                     (needs --enable-unsafe-extension-debugging).
 *   errorCollector()  console.error / uncaught exceptions per CDP session
 *   clickToolbarIcon() Extensions.triggerAction: simulate clicking our
 *                     toolbar icon on a tab (opens the panel, grants activeTab)
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 100, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

export class Cdp {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #listeners = new Set();

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error(`could not connect to ${url}`));
    });
    return new Cdp(ws);
  }

  constructor(ws) {
    this.#ws = ws;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p?.resolve(msg.result);
      } else {
        for (const fn of this.#listeners) fn(msg);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#nextId;
    this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }

  /** Subscribe to CDP events. Returns an unsubscribe function. */
  on(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  close() {
    this.#ws.close();
  }
}

/** Evaluate an expression (may return a Promise) in a session; returns its JSON value. */
export async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

/** Attach to an existing target (flattened); returns the session id. */
export async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
}

// ---------------------------------------------------------------------------
// Chrome process
// ---------------------------------------------------------------------------

/** Start Chrome with a fresh temp profile. Returns { proc, profile, port, wsUrl, headless }. */
export async function launchChrome({ headless = true, extensionDir, extraArgs = [] } = {}) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}. Set CHROME_PATH.`);
  const profile = mkdtempSync(join(tmpdir(), "holt-chrome-"));
  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    ...(extensionDir ? [`--load-extension=${extensionDir}`, "--enable-unsafe-extension-debugging"] : []),
    ...(headless ? ["--headless=new"] : []),
    // Linux CI containers run as root without user namespaces, where
    // Chrome's sandbox refuses to start. Only relax it there.
    ...(process.env.CI && process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    ...extraArgs,
    "about:blank",
  ];
  const proc = spawn(CHROME, args, { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  try {
    const [port, path] = await waitFor(
      () => {
        if (!existsSync(portFile)) return null;
        const lines = readFileSync(portFile, "utf8").split("\n");
        return lines[0] && lines[1] ? lines : null;
      },
      { timeoutMs: 15_000, what: "Chrome's DevToolsActivePort file" },
    );
    return { proc, profile, port, wsUrl: `ws://127.0.0.1:${port}${path}`, headless };
  } catch (error) {
    proc.kill();
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

/** Kill our Chrome (by PID, never by name) and delete its temp profile. */
export async function stopChrome(chrome) {
  if (!chrome) return;
  if (chrome.proc.exitCode === null) {
    const exited = new Promise((r) => chrome.proc.once("exit", r));
    chrome.proc.kill();
    await Promise.race([exited, sleep(3_000)]);
    if (chrome.proc.exitCode === null) chrome.proc.kill("SIGKILL");
  }
  // Best effort: on Linux, Chrome's helper processes can outlive the main one
  // for a moment and keep writing into the profile (ENOTEMPTY seen in CI). A
  // leftover temp dir must not fail the run.
  try {
    rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`[chrome] could not remove the temp profile ${chrome.profile}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Console error collection
// ---------------------------------------------------------------------------

/**
 * Collects console errors / uncaught exceptions for the sessions you `watch`.
 * Network errors (e.g. "connection refused" while no server runs) are
 * reported by Chrome as log entries with source "network"; those are ignored.
 */
export function errorCollector(cdp) {
  const errors = new Map();
  const watched = new Set();
  cdp.on((msg) => {
    if (!watched.has(msg.sessionId)) return;
    let text;
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      text = `uncaught: ${d.exception?.description ?? d.text} (${d.url ?? ""}:${d.lineNumber})`;
    } else if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "assert")) {
      text = `console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`;
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error" && msg.params.entry.source !== "network") {
      text = `log: ${msg.params.entry.text}`;
    }
    if (text) errors.set(msg.sessionId, [...(errors.get(msg.sessionId) ?? []), text]);
  });
  return {
    async watch(sessionId) {
      watched.add(sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Log.enable", {}, sessionId).catch(() => undefined); // not every target has Log
    },
    get: (sessionId) => errors.get(sessionId) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Extension loading
// ---------------------------------------------------------------------------

/**
 * Load `extensionDir` into the connected Chrome and return its service worker
 * session: { sessionId, extensionId, method } or null if it never started.
 * The worker is attached paused at startup and `collector` starts watching it
 * before its first line runs.
 */
export async function loadExtension(cdp, extensionDir, collector, { log = () => {} } = {}) {
  let worker = null;
  cdp.on(async (msg) => {
    if (msg.method !== "Target.attachedToTarget") return;
    const { sessionId, targetInfo } = msg.params;
    if (targetInfo.url.startsWith("chrome-extension://") && targetInfo.url.endsWith("/background.js")) {
      await collector.watch(sessionId);
      worker = { sessionId, extensionId: new URL(targetInfo.url).host };
    }
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
  });
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "service_worker", exclude: false }, { exclude: true }],
  });

  for (let i = 0; i < 30 && !worker; i++) await sleep(100);
  if (worker) return { ...worker, method: "--load-extension" };

  try {
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: extensionDir });
    log(`loaded via Extensions.loadUnpacked, id ${id}`);
  } catch (error) {
    log(`Extensions.loadUnpacked failed: ${error.message}`);
  }
  for (let i = 0; i < 50 && !worker; i++) await sleep(100);
  return worker ? { ...worker, method: "CDP Extensions.loadUnpacked" } : null;
}

/** The CDP "tab" target for a URL (Extensions.triggerAction wants a tab, not a page). */
export async function tabTargetFor(cdp, url) {
  const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
  return targetInfos.find((t) => t.url === url) ?? null;
}

/** Simulate a click on our toolbar icon in the tab showing `url`. Throws if unsupported. */
export async function clickToolbarIcon(cdp, extensionId, url) {
  const tab = await tabTargetFor(cdp, url);
  if (!tab) throw new Error(`no tab target for ${url}`);
  await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: tab.targetId });
}
