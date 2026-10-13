#!/usr/bin/env node
/**
 * Smoke test: load dist/ into a real Chrome and check it starts cleanly.
 * No dependencies: Node 22's global WebSocket speaks the Chrome DevTools
 * Protocol (CDP) directly.
 *
 *   1. Launch Chrome with a fresh temporary profile, --remote-debugging-port=0
 *      (Chrome picks a port and writes it to <profile>/DevToolsActivePort).
 *      Headless first; headed if the extension's worker never appears.
 *   2. Auto-attach to service workers *paused at startup*, so errors thrown
 *      while background.js is first evaluated are not missed.
 *   3. Load the extension. `--load-extension` is passed, but branded Google
 *      Chrome ignores it since v137; in that case we fall back to the CDP
 *      command Extensions.loadUnpacked (needs --enable-unsafe-extension-debugging).
 *   4. Fail on any console.error / uncaught exception in the worker within ~3 s.
 *   5. Extra checks: commands registered, the side panel page renders without
 *      errors, the on-demand content scripts work on a local fixture page
 *      (page-helper metrics/scroll/restore, area-select overlay idempotency
 *      and the Esc-cancel round trip back to the panel as a toast), and a
 *      simulated toolbar click (Extensions.triggerAction) both opens the side
 *      panel and grants activeTab (captureVisibleTab succeeds).
 *
 * Usage: pnpm --filter @nitpick/extension smoke   (build first)
 * Env:   CHROME_PATH=/path/to/chrome   to use another Chrome/Chromium.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist");
const ERROR_WINDOW_MS = 3_000;
const EXPECTED_COMMANDS = ["open-panel", "screenshot-viewport", "screenshot-full", "screenshot-area", "toggle-recording", "toggle-voice", "quick-note"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log("[smoke]", ...args);

if (!existsSync(join(DIST, "manifest.json"))) {
  console.error("[smoke] dist/ not built. Run: pnpm --filter @nitpick/extension build");
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`[smoke] Chrome not found at ${CHROME}. Set CHROME_PATH.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal CDP client (flattened sessions over one browser WebSocket)
// ---------------------------------------------------------------------------

class Cdp {
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

  on(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  close() {
    this.#ws.close();
  }
}

/** Evaluate an expression (may be async) in a session and return its value. */
async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Chrome process
// ---------------------------------------------------------------------------

async function launchChrome(headless) {
  const profile = mkdtempSync(join(tmpdir(), "nitpick-smoke-"));
  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    `--load-extension=${DIST}`,
    "--enable-unsafe-extension-debugging",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const proc = spawn(CHROME, args, { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").split("\n");
      if (port && path) {
        const wsUrl = `ws://127.0.0.1:${port}${path}`;
        return { proc, profile, port, wsUrl };
      }
    }
    await sleep(100);
  }
  proc.kill();
  throw new Error("Chrome did not write DevToolsActivePort");
}

function stopChrome(chrome) {
  if (!chrome) return;
  chrome.proc.kill();
  // Give Chrome a moment to release the profile before deleting it.
  setTimeout(() => rmSync(chrome.profile, { recursive: true, force: true }), 500).unref();
}

// ---------------------------------------------------------------------------
// Fixture page for the content scripts (served on 127.0.0.1, which our
// host_permissions cover, so the worker can inject without an activeTab grant)
// ---------------------------------------------------------------------------

function startFixtureServer() {
  const html = `<!doctype html><title>nitpick smoke fixture</title>
    <style>body{margin:0;font:16px system-ui} header{position:fixed;top:0;left:0;right:0;height:40px;background:#eee}
    .tall{height:6000px;background:linear-gradient(#fff,#4c6ef5)}</style>
    <header>fixed header</header><div class="tall"></div>`;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server)));
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

/** Collects console errors/exceptions per CDP session. */
function errorCollector(cdp) {
  const errors = new Map(); // sessionId -> string[]
  const watched = new Set();
  cdp.on((msg) => {
    if (!watched.has(msg.sessionId)) return;
    const list = errors.get(msg.sessionId) ?? [];
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      list.push(`uncaught: ${d.exception?.description ?? d.text} (${d.url ?? ""}:${d.lineNumber})`);
    } else if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "assert")) {
      list.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      // Network errors (e.g. the nitpick server not running) are expected here.
      if (msg.params.entry.source === "network") return;
      list.push(`log: ${msg.params.entry.text}`);
    } else {
      return;
    }
    errors.set(msg.sessionId, list);
  });
  return {
    async watch(sessionId) {
      watched.add(sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Log.enable", {}, sessionId).catch(() => undefined); // not all targets support Log
    },
    get: (sessionId) => errors.get(sessionId) ?? [],
  };
}

async function run(headless) {
  const chrome = await launchChrome(headless);
  const cdp = await Cdp.connect(chrome.wsUrl);
  const collector = errorCollector(cdp);
  log(`Chrome ${headless ? "headless" : "headed"}, DevTools on port ${chrome.port}`);

  try {
    // Attach to every new service worker, paused before its first line runs.
    let worker = null; // { sessionId, extensionId }
    cdp.on(async (msg) => {
      if (msg.method !== "Target.attachedToTarget") return;
      const { sessionId, targetInfo } = msg.params;
      const isOurs = targetInfo.url.startsWith("chrome-extension://") && targetInfo.url.endsWith("/background.js");
      if (isOurs) {
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

    // Did --load-extension work? (Not in branded Chrome >= 137.)
    for (let i = 0; i < 30 && !worker; i++) await sleep(100);
    let method = "--load-extension";
    if (!worker) {
      method = "CDP Extensions.loadUnpacked";
      try {
        const { id } = await cdp.send("Extensions.loadUnpacked", { path: DIST });
        log(`loaded via Extensions.loadUnpacked, id ${id}`);
      } catch (error) {
        log(`Extensions.loadUnpacked failed: ${error.message}`);
      }
      for (let i = 0; i < 50 && !worker; i++) await sleep(100);
    }
    if (!worker) return { ok: false, retryHeaded: headless, problems: ["extension service worker never appeared"] };
    log(`service worker running (${method}), extension id ${worker.extensionId}`);

    const problems = [];
    const expect = (cond, message) => cond || problems.push(message);

    // ---- 1. worker starts cleanly ------------------------------------------
    await sleep(ERROR_WINDOW_MS);
    for (const e of collector.get(worker.sessionId)) problems.push(`worker: ${e}`);

    // ---- 2. worker state -----------------------------------------------------
    const commands = await evaluate(cdp, worker.sessionId, "chrome.commands.getAll().then(cs => cs.map(c => c.name))");
    for (const name of EXPECTED_COMMANDS) expect(commands.includes(name), `command not registered: ${name}`);
    const behavior = await evaluate(cdp, worker.sessionId, "chrome.sidePanel.getPanelBehavior()");
    // We open the panel from action.onClicked instead (see background/index.ts).
    expect(behavior?.openPanelOnActionClick === false, "openPanelOnActionClick should be false");
    log(`commands: ${commands.join(", ")}; openPanelOnActionClick=${behavior?.openPanelOnActionClick}`);

    // ---- 3. side panel page (opened as a tab: same page, same code) ---------
    const panelUrl = `chrome-extension://${worker.extensionId}/sidepanel.html`;
    const { targetId: panelTarget } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId: panel } = await cdp.send("Target.attachToTarget", { targetId: panelTarget, flatten: true });
    await collector.watch(panel);
    await cdp.send("Page.enable", {}, panel);
    await cdp.send("Page.navigate", { url: panelUrl }, panel);
    await sleep(ERROR_WINDOW_MS);
    for (const e of collector.get(panel)) problems.push(`side panel: ${e}`);
    const panelText = await evaluate(cdp, panel, "document.body.textContent"); // innerText would apply text-transform
    expect(panelText.includes("Capture") && panelText.includes("Settings"), "side panel did not render its sections");
    const serverLine = await evaluate(cdp, panel, "document.querySelector('.server-line')?.innerText ?? ''");
    log(`side panel rendered; server line: "${serverLine.replace(/\s+/g, " ").slice(0, 120)}"`);

    // ---- 4. content scripts on a fixture page ------------------------------
    const fixture = await startFixtureServer();
    const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
    try {
      const { targetId: pageTarget } = await cdp.send("Target.createTarget", { url: fixtureUrl });
      const { sessionId: page } = await cdp.send("Target.attachToTarget", { targetId: pageTarget, flatten: true });
      await collector.watch(page);
      await cdp.send("Page.enable", {}, page);
      await sleep(800);

      const result = await evaluate(
        cdp,
        worker.sessionId,
        `(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find(t => t.url === ${JSON.stringify(fixtureUrl)});
          if (!tab) return { error: "fixture tab not visible to the extension" };
          const inject = (file) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
          // Inject twice: must be idempotent (one listener -> one answer).
          await inject("content/page-helper.js");
          await inject("content/page-helper.js");
          const metrics = await chrome.tabs.sendMessage(tab.id, { type: "helper:metrics" });
          const scrolled = await chrome.tabs.sendMessage(tab.id, { type: "helper:scroll-to", y: 1000 });
          await chrome.tabs.sendMessage(tab.id, { type: "helper:restore" });
          const [{ result: afterRestore }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => scrollY });
          await inject("content/area-select.js");
          await inject("content/area-select.js");
          const [{ result: overlays }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, func: () => document.querySelectorAll("nitpick-area-select").length });
          return { tabId: tab.id, title: tab.title, metrics, scrolled, afterRestore, overlays };
        })()`,
      );
      if (result.error) {
        problems.push(result.error);
      } else {
        log(`page-helper: scrollHeight=${result.metrics.scrollHeight} inner=${result.metrics.innerWidth}x${result.metrics.innerHeight} dpr=${result.metrics.devicePixelRatio}; scroll-to 1000 -> ${result.scrolled.scrollY}; restored -> ${result.afterRestore}`);
        expect(result.title === "nitpick smoke fixture", `tab title not visible to the extension (got ${result.title})`);
        expect(result.metrics.scrollHeight >= 6000, `unexpected scrollHeight ${result.metrics.scrollHeight}`);
        expect(result.scrolled.scrollY === 1000, `scroll-to landed at ${result.scrolled.scrollY}`);
        expect(result.afterRestore === 0, `restore left scrollY at ${result.afterRestore}`);
        expect(result.overlays === 1, `area-select injected twice should give 1 overlay, got ${result.overlays}`);

        // Press Esc in the page: overlay removes itself, sends area-cancelled,
        // the worker broadcasts a toast, and the open panel shows it.
        await cdp.send("Page.bringToFront", {}, page);
        for (const type of ["keyDown", "keyUp"]) {
          await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, page);
        }
        await sleep(500);
        const overlaysAfterEsc = await evaluate(cdp, page, "document.querySelectorAll('nitpick-area-select').length");
        expect(overlaysAfterEsc === 0, "Esc did not remove the area-select overlay");
        const toastSeen = await evaluate(cdp, panel, "document.getElementById('toasts').innerText.includes('Area selection cancelled')");
        expect(toastSeen, "panel did not receive the 'area selection cancelled' toast from the worker");
        log(`area-select: 1 overlay after double injection; Esc removed it=${overlaysAfterEsc === 0}; panel toast=${toastSeen}`);
      }
      // ---- 5. toolbar click: opens the panel AND grants activeTab ---------
      // Extensions.triggerAction simulates clicking our toolbar icon on a tab.
      const { targetInfos: tabs } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
      const fixtureTab = tabs.find((t) => t.url === fixtureUrl);
      let triggered = false;
      try {
        await cdp.send("Extensions.triggerAction", { id: worker.extensionId, targetId: fixtureTab?.targetId });
        triggered = true;
      } catch (error) {
        log(`skipping toolbar-click check: ${error.message}`);
      }
      if (triggered) {
        await sleep(1000);
        const { targetInfos: all } = await cdp.send("Target.getTargets");
        const panels = all.filter((t) => t.url === panelUrl && t.targetId !== panelTarget);
        const canCapture = await evaluate(
          cdp,
          worker.sessionId,
          `chrome.tabs.query({}).then(ts => ts.find(t => t.url === ${JSON.stringify(fixtureUrl)}))
             .then(t => chrome.tabs.captureVisibleTab(t.windowId, { format: "jpeg", quality: 1 }))
             .then(() => true, (e) => String(e.message ?? e))`,
        );
        expect(panels.length > 0, "toolbar click did not open the side panel");
        expect(canCapture === true, `toolbar click did not grant activeTab: ${canCapture}`);
        log(`toolbar click: side panel opened=${panels.length > 0}; activeTab granted=${canCapture === true}`);
      }

      await sleep(300);
      for (const e of collector.get(page)) problems.push(`fixture page: ${e}`);
    } finally {
      fixture.close();
    }

    // Anything the worker logged during the later steps counts too.
    for (const e of collector.get(worker.sessionId)) if (!problems.includes(`worker: ${e}`)) problems.push(`worker: ${e}`);
    for (const e of collector.get(panel)) if (!problems.includes(`side panel: ${e}`)) problems.push(`side panel: ${e}`);

    return { ok: problems.length === 0, problems };
  } finally {
    cdp.close();
    stopChrome(chrome);
  }
}

let outcome = await run(true);
if (!outcome.ok && outcome.retryHeaded) {
  log("headless Chrome did not start the extension; retrying headed");
  outcome = await run(false);
}
if (outcome.ok) {
  log("PASS");
  process.exit(0);
}
console.error("[smoke] FAIL\n  - " + outcome.problems.join("\n  - "));
process.exit(1);
