#!/usr/bin/env node
/**
 * Smoke test: load dist/ into a real Chrome and check it starts cleanly.
 * No server needed (see e2e.mjs for the full round trip with the server).
 *
 *   1. Launch Chrome (headless first; headed if the worker never appears)
 *      and load the extension (see lib/chrome.mjs for how and why).
 *   2. Fail on any console.error / uncaught exception in the worker within ~3 s.
 *   3. Extra checks: commands registered with the intended default keys (4
 *      bound, the rest unbound; CI runs on Linux, so this also catches a
 *      default that is a Chrome shortcut there, which Chrome refuses to
 *      assign), no offscreen document at startup, a voice
 *      note without microphone permission fails fast and offers
 *      permissions.html in the panel, the side panel page renders without
 *      errors and migrates legacy storage.sync settings to storage.local, the on-demand content scripts work on a local fixture page
 *      (page-helper metrics/scroll/restore incl. hiding and restoring the
 *      fixed header; content scripts can't read storage and their forged
 *      capture/toast messages are refused; area-select overlay idempotency
 *      and the Esc-cancel round trip back to the panel as a toast), and a
 *      simulated toolbar click both opens the side panel and grants
 *      activeTab (captureVisibleTab succeeds), and page-helper metrics taken
 *      as soon as the panel starts narrowing the page wait for the final width.
 *
 * Usage: pnpm --filter @holt/extension smoke   (build first)
 * Env:   CHROME_PATH=/path/to/chrome   to use another Chrome/Chromium.
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Cdp,
  attach,
  clickToolbarIcon,
  errorCollector,
  evaluate,
  launchChrome,
  loadExtension,
  sleep,
  stopChrome,
  waitFor,
} from "./lib/chrome.mjs";

const DIST = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist");
const ERROR_WINDOW_MS = 3_000;
const EXPECTED_COMMANDS = ["open-panel", "screenshot-viewport", "screenshot-full", "screenshot-area", "toggle-recording", "toggle-voice", "quick-note"];
const log = (...args) => console.log("[smoke]", ...args);

if (!existsSync(join(DIST, "manifest.json"))) {
  console.error("[smoke] dist/ not built. Run: pnpm --filter @holt/extension build");
  process.exit(1);
}

/** Fixture page on 127.0.0.1 (our host_permissions cover it, so the worker can inject without activeTab). */
function startFixtureServer() {
  const html = `<!doctype html><title>holt smoke fixture</title>
    <style>body{margin:0;font:16px system-ui} header{position:fixed;top:0;left:0;right:0;height:40px;background:#eee}
    .tall{height:6000px;background:linear-gradient(#fff,#4c6ef5)}</style>
    <header>fixed header</header><div class="tall"></div>`;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server)));
}

async function run(headless) {
  // A fake microphone, so the voice-note check below behaves the same on a CI
  // runner (no audio hardware: getUserMedia fails with NotFoundError) as on a
  // laptop. No --use-fake-ui-for-media-stream: permission must stay ungranted.
  const chrome = await launchChrome({ headless, extensionDir: DIST, extraArgs: ["--use-fake-device-for-media-stream"] });
  const cdp = await Cdp.connect(chrome.wsUrl);
  const collector = errorCollector(cdp);
  log(`Chrome ${headless ? "headless" : "headed"}, DevTools on port ${chrome.port}`);

  try {
    const worker = await loadExtension(cdp, DIST, collector, { log });
    if (!worker) return { ok: false, retryHeaded: headless, problems: ["extension service worker never appeared"] };
    log(`service worker running (${worker.method}), extension id ${worker.extensionId}`);

    const problems = [];
    const expect = (cond, message) => cond || problems.push(message);

    // ---- 1. worker starts cleanly ------------------------------------------
    await sleep(ERROR_WINDOW_MS);

    // ---- 2. worker state -----------------------------------------------------
    const commands = await evaluate(cdp, worker.sessionId, "chrome.commands.getAll().then(cs => cs.map(c => c.name))");
    for (const name of EXPECTED_COMMANDS) expect(commands.includes(name), `command not registered: ${name}`);
    const bindings = await evaluate(cdp, worker.sessionId, "chrome.commands.getAll().then(cs => Object.fromEntries(cs.map(c => [c.name, c.shortcut])))");
    // Fresh profile, no other extensions: an unbound default here means Chrome
    // refused the suggested key, usually because it is one of Chrome's own
    // shortcuts on this platform (e.g. Alt+D on Windows/Linux).
    for (const name of ["screenshot-area", "toggle-voice", "toggle-recording", "quick-note"]) {
      expect(bindings[name], `${name} has no default shortcut on ${process.platform} (is its suggested key a Chrome shortcut here?): ${JSON.stringify(bindings)}`);
    }
    for (const name of ["screenshot-viewport", "screenshot-full", "open-panel"]) {
      expect(!bindings[name], `${name} should ship unbound, has ${bindings[name]}`);
    }
    log(`shortcuts: ${Object.entries(bindings).map(([k, v]) => `${k}=${v || "-"}`).join(" ")}`);
    const offscreenAtStart = (await cdp.send("Target.getTargets")).targetInfos.some((t) => t.url.endsWith("/offscreen.html"));
    expect(!offscreenAtStart, "an offscreen document exists before anything was recorded");
    const behavior = await evaluate(cdp, worker.sessionId, "chrome.sidePanel.getPanelBehavior()");
    // We open the panel from action.onClicked instead (see background/index.ts).
    expect(behavior?.openPanelOnActionClick === false, "openPanelOnActionClick should be false");
    log(`commands: ${commands.join(", ")}; openPanelOnActionClick=${behavior?.openPanelOnActionClick}`);

    // ---- 3. side panel page (opened as a tab: same page, same code) ---------
    // Seed legacy settings in storage.sync (where earlier builds kept them):
    // the panel must migrate them to storage.local on load.
    await evaluate(cdp, worker.sessionId, `chrome.storage.sync.set({ serverUrl: "http://localhost:4999", keepAudio: false })`);
    const panelUrl = `chrome-extension://${worker.extensionId}/sidepanel.html`;
    const { targetId: panelTarget } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const panel = await attach(cdp, panelTarget);
    await collector.watch(panel);
    await cdp.send("Page.enable", {}, panel);
    await cdp.send("Page.navigate", { url: panelUrl }, panel);
    await sleep(ERROR_WINDOW_MS);
    const panelText = await evaluate(cdp, panel, "document.body.textContent"); // innerText would apply text-transform
    expect(panelText.includes("Capture") && panelText.includes("Settings"), "side panel did not render its sections");
    const serverLine = await evaluate(cdp, panel, "document.querySelector('.server-line')?.innerText ?? ''");
    log(`side panel rendered; server line: "${serverLine.replace(/\s+/g, " ").slice(0, 120)}"`);
    const stores = await evaluate(cdp, worker.sessionId, `Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get(null)])`);
    expect(Object.keys(stores[0]).length === 0, `storage.sync still has settings after migration: ${JSON.stringify(stores[0])}`);
    expect(stores[1].serverUrl === "http://localhost:4999" && stores[1].keepAudio === false, `settings not migrated to storage.local: ${JSON.stringify(stores[1])}`);
    expect(serverLine.includes("localhost:4999"), "panel is not using the migrated server URL");
    log(`settings migration: sync -> local ${JSON.stringify(stores[1])}; sync now ${JSON.stringify(stores[0])}`);

    // ---- 3b. voice note without microphone permission --------------------------
    // There is a (fake) microphone but no grant for the extension. The
    // offscreen recorder can't show a prompt; the start must fail fast and
    // the panel must offer permissions.html. Any voice-note toast ends the
    // wait, so a failure reports what the panel said instead.
    await evaluate(cdp, worker.sessionId, `holtTest.handleCommand("toggle-voice", undefined)`);
    const micToast = await waitFor(
      () => evaluate(cdp, panel, `(() => { const t = document.getElementById('toasts'); return /microphone|voice note/i.test(t.innerText) ? t.innerText : null; })()`),
      { timeoutMs: 8_000, what: "a voice-note toast" },
    ).catch(() => null);
    expect(/Microphone access is blocked/.test(micToast ?? "") && micToast.includes("Grant microphone access"), `no 'Grant microphone access' offer after a voice note without permission; panel toasts: ${JSON.stringify(micToast)}`);
    const voiceLeft = await evaluate(cdp, worker.sessionId, `chrome.storage.session.get("recordingVoice").then(s => s.recordingVoice ?? null)`);
    expect(voiceLeft === null, "a failed voice note left recording state behind");
    log(`voice note without permission: ${micToast ? "panel offered permissions.html" : "NO toast"}; state cleared=${voiceLeft === null}`);

    // ---- 4. content scripts on a fixture page ------------------------------
    const fixture = await startFixtureServer();
    const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
    let page;
    try {
      const { targetId: pageTarget } = await cdp.send("Target.createTarget", { url: fixtureUrl });
      page = await attach(cdp, pageTarget);
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
          const scrolled = await chrome.tabs.sendMessage(tab.id, { type: "helper:scroll-to", y: 1000, hideFixed: true });
          const headerState = () => chrome.scripting.executeScript({ target: { tabId: tab.id },
            func: () => getComputedStyle(document.querySelector("header")).visibility + "|" + document.querySelector("header").style.cssText });
          const [{ result: headerWhileHidden }] = await headerState();
          await chrome.tabs.sendMessage(tab.id, { type: "helper:restore" });
          const [{ result: headerAfterRestore }] = await headerState();
          const [{ result: afterRestore }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => scrollY });
          // Security probes, run as a content script (isolated world) in the page:
          // storage must be off limits, forged capture/toast must be refused.
          const [{ result: probes }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (windowId) => {
              let storage;
              try {
                await chrome.storage.local.get("token");
                storage = "readable";
              } catch (e) {
                storage = "denied: " + e.message;
              }
              const capture = await chrome.runtime.sendMessage({ type: "capture", mode: "viewport", windowId })
                .catch((e) => ({ error: e.message }));
              const toast = await chrome.runtime.sendMessage({ type: "toast", level: "error", message: "forged-by-content-script" })
                .then((r) => ({ answered: r }), (e) => ({ error: e.message }));
              // New in the offscreen-recorder design: none of these may be accepted from a page.
              const answer = (m) => chrome.runtime.sendMessage(m).then((r) => r ?? null, (e) => ({ error: e.message }));
              const toggle = await answer({ type: "recorder:toggle", recorder: "voice", windowId });
              const created = await answer({ type: "entry-created", entry: { id: "x", seq: 1 }, session: { id: "s" } });
              const stopped = await answer({ type: "recorder:stopped", recorder: "voice", id: "x" });
              const startVoice = await answer({ type: "offscreen:start-voice", id: "x", page: { url: "", title: "" },
                settings: { serverUrl: "http://evil.example", token: "", keepAudio: true, microphoneId: "", microphoneLabel: "" } });
              return { storage, capture, toast, toggle, created, stopped, startVoice };
            },
            args: [tab.windowId],
          });
          // What startAreaSelection would record before injecting the overlay,
          // so the Esc below is accepted as coming from the pending tab.
          await chrome.storage.session.set({ pendingArea: { tabId: tab.id, windowId: tab.windowId,
            page: { url: tab.url, title: tab.title }, startedAt: Date.now() } });
          await inject("content/area-select.js");
          await inject("content/area-select.js");
          const [{ result: overlays }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, func: () => document.querySelectorAll("holt-area-select").length });
          return { title: tab.title, metrics, scrolled, afterRestore, overlays, headerWhileHidden, headerAfterRestore, probes };
        })()`,
      );
      if (result.error) {
        problems.push(result.error);
      } else {
        log(`page-helper: scrollHeight=${result.metrics.scrollHeight} inner=${result.metrics.innerWidth}x${result.metrics.innerHeight} dpr=${result.metrics.devicePixelRatio}; scroll-to 1000 -> ${result.scrolled.scrollY}; restored -> ${result.afterRestore}`);
        expect(result.title === "holt smoke fixture", `tab title not visible to the extension (got ${result.title})`);
        expect(result.metrics.scrollHeight >= 6000, `unexpected scrollHeight ${result.metrics.scrollHeight}`);
        expect(result.scrolled.scrollY === 1000, `scroll-to landed at ${result.scrolled.scrollY}`);
        expect(result.afterRestore === 0, `restore left scrollY at ${result.afterRestore}`);
        expect(result.metrics.widthStable === true, "page-helper reported an unstable viewport width");
        expect(result.scrolled.hiddenCount === 1, `hideFixed should hide the 1 fixed header, hid ${result.scrolled.hiddenCount}`);
        expect(result.headerWhileHidden.startsWith("hidden|"), `fixed header not hidden during capture: ${result.headerWhileHidden}`);
        expect(result.headerAfterRestore === "visible|", `fixed header not restored exactly: ${result.headerAfterRestore}`);
        log(`pinned elements: hid ${result.scrolled.hiddenCount} (${result.headerWhileHidden.split("|")[0]}), after restore "${result.headerAfterRestore}"`);
        expect(result.overlays === 1, `area-select injected twice should give 1 overlay, got ${result.overlays}`);

        const { probes } = result;
        expect(probes.storage.startsWith("denied"), `content scripts can read chrome.storage.local (${probes.storage})`);
        expect(probes.capture?.ok === false && /side panel/.test(probes.capture.error ?? ""), `forged capture from a content script was not refused: ${JSON.stringify(probes.capture)}`);
        expect(!probes.toast.answered, `forged toast from a content script was answered: ${JSON.stringify(probes.toast)}`);
        expect(probes.toggle?.ok === false && /side panel/.test(probes.toggle.error ?? ""), `forged recorder:toggle was not refused: ${JSON.stringify(probes.toggle)}`);
        for (const key of ["created", "stopped", "startVoice"]) {
          expect(probes[key] === null || probes[key]?.error, `forged ${key} from a content script was answered: ${JSON.stringify(probes[key])}`);
        }
        log(`forged recorder messages: toggle -> ${JSON.stringify(probes.toggle)}; entry-created/recorder:stopped/offscreen:start-voice -> ${["created", "stopped", "startVoice"].map((k) => JSON.stringify(probes[k])).join(", ")}`);
        log(`content-script probes: storage ${probes.storage.slice(0, 60)}; capture -> ${JSON.stringify(probes.capture)}; toast -> ${probes.toast.error ?? (probes.toast.answered === undefined ? "no response (ignored)" : JSON.stringify(probes.toast.answered))}`);

        // Press Esc in the page: overlay removes itself, sends area-cancelled,
        // the worker broadcasts a toast, and the open panel shows it.
        await cdp.send("Page.bringToFront", {}, page);
        for (const type of ["keyDown", "keyUp"]) {
          await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, page);
        }
        await sleep(500);
        const overlaysAfterEsc = await evaluate(cdp, page, "document.querySelectorAll('holt-area-select').length");
        expect(overlaysAfterEsc === 0, "Esc did not remove the area-select overlay");
        const toastSeen = await evaluate(cdp, panel, "document.getElementById('toasts').innerText.includes('Area selection cancelled')");
        expect(toastSeen, "panel did not receive the 'area selection cancelled' toast from the worker");
        const forgedShown = await evaluate(cdp, panel, "document.getElementById('toasts').innerText.includes('forged-by-content-script')");
        expect(!forgedShown, "panel displayed a toast forged by a content script");
        log(`area-select: 1 overlay after double injection; Esc removed it=${overlaysAfterEsc === 0}; panel toast=${toastSeen}`);
      }

      // ---- 5. toolbar click: opens the panel AND grants activeTab ---------
      // Record every width the page goes through while the panel opens.
      await evaluate(cdp, page, `window.__holtWidths = [innerWidth]; addEventListener("resize", () => __holtWidths.push(innerWidth)); true`);
      let triggered = false;
      try {
        await clickToolbarIcon(cdp, worker.extensionId, fixtureUrl);
        triggered = true;
      } catch (error) {
        log(`skipping toolbar-click check: ${error.message}`);
      }
      if (triggered) {
        // As soon as the panel starts narrowing the page, while it may still be
        // animating: the helper must wait for the width to settle before
        // measuring. Wait for that first resize rather than asking right after
        // the click: on a slow CI runner the panel can take longer to start
        // than the helper's stability window, and the helper can't know a
        // resize is still coming.
        const narrowing = await waitFor(() => evaluate(cdp, page, "__holtWidths.length > 1"), {
          timeoutMs: 5_000,
          intervalMs: 10,
          what: "the side panel to narrow the page",
        }).catch(() => false);
        expect(narrowing, "the page never got narrower after the toolbar click opened the side panel");
        const early = await evaluate(
          cdp,
          worker.sessionId,
          `chrome.tabs.query({}).then(ts => ts.find(t => t.url === ${JSON.stringify(fixtureUrl)}))
             .then(t => chrome.tabs.sendMessage(t.id, { type: "helper:metrics" }))`,
        );
        await sleep(1000);
        const settledWidth = await evaluate(cdp, page, "innerWidth");
        expect(early.widthStable === true, "helper:metrics right after the panel opened reported an unstable width");
        expect(early.innerWidth === settledWidth, `helper:metrics measured ${early.innerWidth}px wide during the panel animation; settled width is ${settledWidth}px`);
        const widths = await evaluate(cdp, page, "__holtWidths");
        log(`metrics once the page started narrowing: width ${early.innerWidth} (settled: ${settledWidth}; widths seen: ${widths.join(" -> ")}), stable=${early.widthStable}`);
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
    } finally {
      fixture.close();
    }

    for (const [name, session] of [["worker", worker.sessionId], ["side panel", panel], ["fixture page", page]]) {
      if (session) for (const e of collector.get(session)) problems.push(`${name}: ${e}`);
    }
    return { ok: problems.length === 0, problems };
  } finally {
    cdp.close();
    await stopChrome(chrome);
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
