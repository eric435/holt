#!/usr/bin/env node
/**
 * Smoke test: load dist/ into a real Chrome and check it starts cleanly.
 * No server needed (see e2e.mjs for the full round trip with the server).
 *
 *   1. Launch Chrome (headless first; headed if the worker never appears)
 *      and load the extension (see lib/chrome.mjs for how and why).
 *   2. Fail on any console.error / uncaught exception in the worker within ~3 s.
 *   3. Extra checks: commands registered, the side panel page renders without
 *      errors, the on-demand content scripts work on a local fixture page
 *      (page-helper metrics/scroll/restore, area-select overlay idempotency
 *      and the Esc-cancel round trip back to the panel as a toast), and a
 *      simulated toolbar click both opens the side panel and grants
 *      activeTab (captureVisibleTab succeeds).
 *
 * Usage: pnpm --filter @nitpick/extension smoke   (build first)
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
} from "./lib/chrome.mjs";

const DIST = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "dist");
const ERROR_WINDOW_MS = 3_000;
const EXPECTED_COMMANDS = ["open-panel", "screenshot-viewport", "screenshot-full", "screenshot-area", "toggle-recording", "toggle-voice", "quick-note"];
const log = (...args) => console.log("[smoke]", ...args);

if (!existsSync(join(DIST, "manifest.json"))) {
  console.error("[smoke] dist/ not built. Run: pnpm --filter @nitpick/extension build");
  process.exit(1);
}

/** Fixture page on 127.0.0.1 (our host_permissions cover it, so the worker can inject without activeTab). */
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

async function run(headless) {
  const chrome = await launchChrome({ headless, extensionDir: DIST });
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
    const behavior = await evaluate(cdp, worker.sessionId, "chrome.sidePanel.getPanelBehavior()");
    // We open the panel from action.onClicked instead (see background/index.ts).
    expect(behavior?.openPanelOnActionClick === false, "openPanelOnActionClick should be false");
    log(`commands: ${commands.join(", ")}; openPanelOnActionClick=${behavior?.openPanelOnActionClick}`);

    // ---- 3. side panel page (opened as a tab: same page, same code) ---------
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
          const scrolled = await chrome.tabs.sendMessage(tab.id, { type: "helper:scroll-to", y: 1000 });
          await chrome.tabs.sendMessage(tab.id, { type: "helper:restore" });
          const [{ result: afterRestore }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => scrollY });
          await inject("content/area-select.js");
          await inject("content/area-select.js");
          const [{ result: overlays }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, func: () => document.querySelectorAll("nitpick-area-select").length });
          return { title: tab.title, metrics, scrolled, afterRestore, overlays };
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
      let triggered = false;
      try {
        await clickToolbarIcon(cdp, worker.extensionId, fixtureUrl);
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
