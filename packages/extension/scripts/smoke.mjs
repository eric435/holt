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
 *      assign), no offscreen document at startup, the welcome tab opened
 *      on install (exactly one; it names the server commands, lists the
 *      real shortcut bindings, loads nothing remote, and its transcription
 *      switch saves), the panel's transcription switch (keep audio shows
 *      forced on while it is off, the stored choice untouched), a voice
 *      note without microphone permission fails fast and offers
 *      permissions.html in the panel, the side panel page renders without
 *      errors and uses the server URL in storage.local (storage.sync stays
 *      empty), the on-demand content scripts work on a local fixture page
 *      (with no holt server anywhere, the badge turns into a red "!" on the
 *      fixture's loopback page, and the toolbar menu says "Not connected";
 *      page-helper metrics/scroll/restore incl. hiding and restoring the
 *      fixed header; content scripts can't read storage and their forged
 *      menu:run/toast messages and a forged answer (or draft) for the
 *      screenshot note prompt are refused; area-select overlay idempotency
 *      and the Esc-cancel round trip back to the panel as a toast), and a
 *      simulated toolbar click opens the menu and grants activeTab
 *      (captureVisibleTab succeeds), its Settings item opens the side panel,
 *      and page-helper metrics taken as soon as the panel starts narrowing
 *      the page wait for the final width. A Chrome that can't simulate the
 *      toolbar click (no Extensions.triggerAction) skips that last part with
 *      a warning locally; with CI set, that is a failure.
 *
 * Usage: pnpm --filter @holt/extension smoke   (build first)
 * Env:   CHROME_PATH=/path/to/chrome   to use another Chrome/Chromium.
 *        CI=1                          no skipped sections (GitHub Actions sets it).
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
    // A deliberate fixed wait: the check is that no error shows up within
    // this window, so there is no condition to wait for instead.
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
    // A click on the icon shows the menu (action popup), not the panel (see background/index.ts).
    expect(behavior?.openPanelOnActionClick === false, "openPanelOnActionClick should be false");
    log(`commands: ${commands.join(", ")}; openPanelOnActionClick=${behavior?.openPanelOnActionClick}`);

    // ---- 2b. first install: the welcome tab ----------------------------------
    // A fresh profile, so runtime.onInstalled fired with reason "install" and
    // the worker opened welcome.html in a tab. Reloaded once attached, so its
    // first run is watched for errors too. Closed afterwards, so the rest of
    // this test sees the same tabs as before the welcome page existed.
    const welcomeUrl = `chrome-extension://${worker.extensionId}/welcome.html`;
    const welcomeTargets = await waitFor(
      async () => {
        const found = (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page" && t.url === welcomeUrl);
        return found.length ? found : null;
      },
      { timeoutMs: 5_000, what: "the welcome tab (runtime.onInstalled, reason install)" },
    ).catch((e) => (problems.push(e.message), []));
    expect(welcomeTargets.length <= 1, `${welcomeTargets.length} welcome tabs opened on install (expected 1)`);
    let welcome;
    if (welcomeTargets[0]) {
      welcome = await attach(cdp, welcomeTargets[0].targetId);
      await collector.watch(welcome);
      await cdp.send("Page.enable", {}, welcome);
      await cdp.send("Page.reload", {}, welcome);
      // The server line settles on ok / down / needs-token (whether a holt server runs on this machine is not ours to assume).
      const state = await waitFor(
        () => evaluate(cdp, welcome, "(() => { const s = document.getElementById('server-line')?.dataset.state; return s && s !== 'checking' ? s : null; })()"),
        { timeoutMs: 8_000, what: "the welcome page's server check" },
      ).catch((e) => (problems.push(e.message), null));
      const w = await evaluate(
        cdp,
        welcome,
        `(() => ({
          text: document.body.textContent,
          server: document.getElementById('server-line').innerText,
          rows: [...document.querySelectorAll('#shortcuts dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? ""]),
          toggle: (() => { const i = document.querySelector('.transcribe-setting input'); return i ? { checked: i.checked, label: i.parentElement.textContent } : null; })(),
          remote: performance.getEntriesByType("resource").map((r) => r.name)
            .filter((u) => !u.startsWith(location.origin + "/") && !u.startsWith("http://127.0.0.1:") && !u.startsWith("http://localhost:")),
        }))()`,
      );
      expect(w.text.includes("npx @velvet-thunder/holt") && w.text.includes('import holt from "@velvet-thunder/holt/vite"'), "the welcome page does not say how to start the server");
      expect(w.text.includes("http://127.0.0.1:4848"), "the welcome page does not name the default server address");
      expect(w.rows.length === EXPECTED_COMMANDS.length, `welcome page lists ${w.rows.length} shortcuts, expected ${EXPECTED_COMMANDS.length}`);
      const areaRow = w.rows.find(([label]) => label === "Screenshot: select area");
      expect(areaRow && areaRow[1] === bindings["screenshot-area"], `welcome page shows the area shortcut as ${JSON.stringify(areaRow)}, Chrome has ${bindings["screenshot-area"]}`);
      expect(w.toggle?.checked === true && /Google/.test(w.toggle.label), `welcome page transcription switch: ${JSON.stringify(w.toggle)}`);
      expect(/Google's speech service/.test(w.text), "the welcome page does not say what transcription sends to Google");
      expect(w.remote.length === 0, `the welcome page loaded remote resources: ${w.remote.join(", ")}`);
      // The switch saves at once (and back, so the rest of the test runs with the default).
      const flip = (want) =>
        evaluate(cdp, welcome, `(async () => {
          document.querySelector('.transcribe-setting input').click();
          for (let i = 0; i < 40; i++) {
            const { transcribe } = await chrome.storage.local.get('transcribe');
            if (transcribe === ${want}) return true;
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        })()`);
      expect(await flip(false), "turning transcription off on the welcome page did not save transcribe: false");
      expect(await flip(true), "turning transcription back on on the welcome page did not save transcribe: true");
      log(`welcome tab opened on install; server: ${state} "${w.server.replace(/\s+/g, " ")}"; ${w.rows.length} shortcuts; transcription switch saves`);
      await cdp.send("Target.closeTarget", { targetId: welcomeTargets[0].targetId });
    }

    // ---- 3. side panel page (opened as a tab: same page, same code) ---------
    // A fallback server URL nothing listens on (the later sections rely on
    // it: "no server for this page", "Not connected"). The panel must show it.
    await evaluate(cdp, worker.sessionId, `chrome.storage.local.set({ serverUrl: "http://localhost:4999", keepAudio: false })`);
    const panelUrl = `chrome-extension://${worker.extensionId}/sidepanel.html`;
    const { targetId: panelTarget } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const panel = await attach(cdp, panelTarget);
    await collector.watch(panel);
    await cdp.send("Page.enable", {}, panel);
    await cdp.send("Page.navigate", { url: panelUrl }, panel);
    // Deliberately fixed, as for the worker: the panel's first seconds must
    // produce no console error (collected at the end), not just render.
    await sleep(ERROR_WINDOW_MS);
    // On a slow runner it may still be rendering after that window.
    await waitFor(() => evaluate(cdp, panel, "document.body.textContent.includes('Settings')"), { what: "the side panel to render" }).catch(() => undefined);
    const panelText = await evaluate(cdp, panel, "document.body.textContent"); // innerText would apply text-transform
    expect(panelText.includes("This session") && panelText.includes("Settings"), "side panel did not render its sections");
    expect(!panelText.includes("Capture"), "side panel still has the Capture section (capturing moved to the toolbar menu)");
    const serverLine = await evaluate(cdp, panel, "document.querySelector('.server-line')?.innerText ?? ''");
    log(`side panel rendered; server line: "${serverLine.replace(/\s+/g, " ").slice(0, 120)}"`);
    const stores = await evaluate(cdp, worker.sessionId, `Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get(null)])`);
    // Settings live in storage.local only (shared/settings.ts says why).
    expect(Object.keys(stores[0]).length === 0, `something wrote to storage.sync: ${JSON.stringify(stores[0])}`);
    expect(stores[1].serverUrl === "http://localhost:4999" && stores[1].keepAudio === false, `seeded settings changed in storage.local: ${JSON.stringify(stores[1])}`);
    expect(serverLine.includes("localhost:4999"), "panel is not using the stored server URL");
    log(`settings: local ${JSON.stringify(stores[1])}; sync ${JSON.stringify(stores[0])}`);

    // ---- 3a. transcription switch: keep-audio is forced on while it is off ----
    const speech = await evaluate(cdp, panel, `(async () => {
      const toggle = document.querySelector('.transcribe-setting input');
      const keep = [...document.querySelectorAll('label.check')].find((l) => l.textContent.includes('keep the audio'))?.querySelector('input');
      if (!toggle || !keep) return null;
      const read = async () => ({ checked: keep.checked, disabled: keep.disabled, stored: (await chrome.storage.local.get(['transcribe', 'keepAudio'])) });
      const until = async (cond) => { for (let i = 0; i < 40 && !cond(); i++) await new Promise((r) => setTimeout(r, 50)); };
      const before = await read();
      toggle.click();
      await until(() => keep.disabled);
      const off = await read();
      toggle.click();
      await until(() => !keep.disabled);
      return { before, off, after: await read() };
    })()`);
    expect(speech, "the panel's Settings have no transcription switch (or no keep-audio checkbox)");
    if (speech) {
      expect(!speech.before.disabled && speech.before.checked === false, `keep audio before: ${JSON.stringify(speech.before)}`);
      expect(speech.off.disabled && speech.off.checked && speech.off.stored.transcribe === false && speech.off.stored.keepAudio === false,
        `with transcription off, keep audio should show checked+disabled without changing the stored choice: ${JSON.stringify(speech.off)}`);
      expect(!speech.after.disabled && speech.after.checked === false && speech.after.stored.transcribe === true, `keep audio after turning transcription back on: ${JSON.stringify(speech.after)}`);
      log(`panel transcription switch: off -> keep audio ${speech.off.checked ? "checked" : "unchecked"}/${speech.off.disabled ? "disabled" : "enabled"}, stored keepAudio ${speech.off.stored.keepAudio}; back on -> ${JSON.stringify(speech.after.stored)}`);
    }

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
      await waitFor(() => evaluate(cdp, page, "document.readyState === 'complete' && !!document.querySelector('header')"), { what: "the fixture page to load" });

      // No holt anywhere: the fixture's origin answers every path with HTML
      // (not holt), and the fallback URL (localhost:4999, seeded above) is
      // closed. On a loopback page that is the red "!" badge.
      await cdp.send("Target.activateTarget", { targetId: pageTarget });
      const noServer = await waitFor(
        async () => {
          const info = await evaluate(cdp, worker.sessionId, `chrome.storage.session.get("serverInfo").then(s => s.serverInfo ?? null)`);
          const text = await evaluate(cdp, worker.sessionId, "chrome.action.getBadgeText({})");
          return info?.localPage && text === "!" ? { info, text, title: await evaluate(cdp, worker.sessionId, "chrome.action.getTitle({})") } : null;
        },
        { timeoutMs: 8_000, what: "the red '!' badge on a loopback page without holt" },
      ).catch((e) => (problems.push(e.message), null));
      if (noServer) {
        expect(noServer.info.ok === false && noServer.info.source === "fallback" && noServer.info.serverUrl === "http://localhost:4999", `serverInfo on the fixture page: ${JSON.stringify(noServer.info)}`);
        expect(/^holt: no server for this page — Can't reach the holt server at http:\/\/localhost:4999/.test(noServer.title), `badge tooltip without a server: ${noServer.title}`);
        const probes = await evaluate(cdp, worker.sessionId, `chrome.storage.session.get("serverProbes").then(s => s.serverProbes ?? {})`);
        expect(probes[fixtureUrl.replace(/\/$/, "")]?.ok === false, `the fixture origin was not probed (or not cached as 'not holt'): ${JSON.stringify(probes)}`);
        log(`no server: badge "${noServer.text}", tooltip "${noServer.title.slice(0, 90)}…", probed ${Object.keys(probes).join(", ")}`);
      }

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
          // A screenshot waiting for its note: a page must not be able to answer for the user.
          const pendingShot = { id: "smoke-pending", page: { url: tab.url, title: tab.title }, capturedAt: new Date().toISOString(),
            file: "001-screenshot.png", mode: "viewport", width: 1, height: 1, windowId: tab.windowId, tabId: tab.id, at: Date.now() };
          await chrome.storage.session.set({ pendingScreenshot: pendingShot });
          // Security probes, run as a content script (isolated world) in the page:
          // storage must be off limits, a forged menu command or toast must be refused.
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
              // The toolbar menu's request: what a page would forge to trigger a capture or a recording.
              const menuRun = await chrome.runtime.sendMessage({ type: "menu:run", command: "screenshot-viewport", windowId })
                .catch((e) => ({ error: e.message }));
              const toast = await chrome.runtime.sendMessage({ type: "toast", level: "error", message: "forged-by-content-script" })
                .then((r) => ({ answered: r }), (e) => ({ error: e.message }));
              // New in the offscreen-recorder design: none of these may be accepted from a page.
              const answer = (m) => chrome.runtime.sendMessage(m).then((r) => r ?? null, (e) => ({ error: e.message }));
              const toggle = await answer({ type: "menu:run", command: "toggle-voice", windowId });
              const created = await answer({ type: "entry-created", entry: { id: "x", seq: 1 }, session: { id: "s" } });
              const stopped = await answer({ type: "recorder:stopped", recorder: "voice", id: "x" });
              const startVoice = await answer({ type: "offscreen:start-voice", id: "x", page: { url: "", title: "" },
                settings: { serverUrl: "http://evil.example", token: "", keepAudio: true, microphoneId: "", microphoneLabel: "" } });
              const noteFinish = await answer({ type: "screenshot-note:finish", id: "smoke-pending", note: "forged-by-content-script" });
              const noteDraft = await answer({ type: "screenshot-note:draft", id: "smoke-pending", draft: "forged-by-content-script" });
              const serverRefresh = await answer({ type: "server-info:refresh" });
              return { storage, menuRun, toast, toggle, created, stopped, startVoice, noteFinish, noteDraft, serverRefresh };
            },
            args: [tab.windowId],
          });
          const { pendingScreenshot: pendingAfterProbe } = await chrome.storage.session.get("pendingScreenshot");
          probes.pendingKept = pendingAfterProbe?.id === "smoke-pending";
          probes.draftKept = pendingAfterProbe?.draft === undefined;
          await chrome.storage.session.remove("pendingScreenshot");
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
        expect(probes.menuRun?.ok === false && /toolbar menu/.test(probes.menuRun.error ?? ""), `forged menu:run (screenshot) from a content script was not refused: ${JSON.stringify(probes.menuRun)}`);
        expect(!probes.toast.answered, `forged toast from a content script was answered: ${JSON.stringify(probes.toast)}`);
        expect(probes.toggle?.ok === false && /toolbar menu/.test(probes.toggle.error ?? ""), `forged menu:run (voice note) was not refused: ${JSON.stringify(probes.toggle)}`);
        for (const key of ["created", "stopped", "startVoice", "serverRefresh"]) {
          expect(probes[key] === null || probes[key]?.error, `forged ${key} from a content script was answered: ${JSON.stringify(probes[key])}`);
        }
        expect(probes.noteFinish?.ok === false && /note prompt/.test(probes.noteFinish.error ?? ""), `forged screenshot-note:finish was not refused: ${JSON.stringify(probes.noteFinish)}`);
        expect(probes.pendingKept, "a forged screenshot-note:finish consumed the pending screenshot");
        expect(probes.noteDraft?.ok === false && /note prompt/.test(probes.noteDraft.error ?? ""), `forged screenshot-note:draft was not refused: ${JSON.stringify(probes.noteDraft)}`);
        expect(probes.draftKept, "a forged screenshot-note:draft changed the pending screenshot's draft");
        log(`forged screenshot note: ${JSON.stringify(probes.noteFinish)}, draft: ${JSON.stringify(probes.noteDraft)}; pending screenshot kept=${probes.pendingKept}, draft untouched=${probes.draftKept}`);
        log(`forged recorder messages: menu:run toggle-voice -> ${JSON.stringify(probes.toggle)}; entry-created/recorder:stopped/offscreen:start-voice/server-info:refresh -> ${["created", "stopped", "startVoice", "serverRefresh"].map((k) => JSON.stringify(probes[k])).join(", ")}`);
        log(`content-script probes: storage ${probes.storage.slice(0, 60)}; menu:run screenshot -> ${JSON.stringify(probes.menuRun)}; toast -> ${probes.toast.error ?? (probes.toast.answered === undefined ? "no response (ignored)" : JSON.stringify(probes.toast.answered))}`);

        // Press Esc in the page: overlay removes itself, sends area-cancelled,
        // the worker broadcasts a toast, and the open panel shows it.
        await cdp.send("Page.bringToFront", {}, page);
        for (const type of ["keyDown", "keyUp"]) {
          await cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, page);
        }
        const overlaysAfterEsc = await waitFor(() => evaluate(cdp, page, "document.querySelectorAll('holt-area-select').length === 0"), { timeoutMs: 5_000, what: "Esc to remove the area-select overlay" })
          .then(() => 0, () => -1);
        expect(overlaysAfterEsc === 0, "Esc did not remove the area-select overlay");
        const toastSeen = await waitFor(() => evaluate(cdp, panel, "document.getElementById('toasts').innerText.includes('Area selection cancelled')"), { timeoutMs: 5_000, what: "the 'area selection cancelled' toast" })
          .catch(() => false);
        expect(toastSeen, "panel did not receive the 'area selection cancelled' toast from the worker");
        const forgedShown = await evaluate(cdp, panel, "document.getElementById('toasts').innerText.includes('forged-by-content-script')");
        expect(!forgedShown, "panel displayed a toast forged by a content script");
        log(`area-select: 1 overlay after double injection; Esc removed it=${overlaysAfterEsc === 0}; panel toast=${toastSeen}`);
      }

      // ---- 5. toolbar click: opens the menu AND grants activeTab; Settings opens the panel
      // Record every width the page goes through while the panel opens.
      await evaluate(cdp, page, `window.__holtWidths = [innerWidth]; addEventListener("resize", () => __holtWidths.push(innerWidth)); true`);
      // Extensions.triggerAction is experimental CDP (it needs
      // --enable-unsafe-extension-debugging, see lib/chrome.mjs), and an older
      // or unbranded local Chrome may not have it. Only that one case may
      // skip this section, and only locally, with a warning. CI's Chrome
      // (current google-chrome on ubuntu-latest) has it, and a skip there
      // would silently drop every check below
      // (menu, Settings -> side panel, activeTab, the resize wait) while the
      // run still passed. Anything else that goes wrong here is a failure.
      let menuOpened = false;
      let clicked = false;
      try {
        await clickToolbarIcon(cdp, worker.extensionId, fixtureUrl);
        clicked = true;
      } catch (error) {
        const unsupported = /wasn't found|method not found/i.test(error.message);
        if (unsupported && !process.env.CI) log(`WARNING: this Chrome cannot simulate a toolbar click, skipping the menu, side panel and activeTab checks: ${error.message}`);
        else problems.push(`simulated toolbar click (Extensions.triggerAction) failed: ${error.message}`);
      }
      if (clicked) {
        try {
          const menuUrl = `chrome-extension://${worker.extensionId}/menu.html`;
          const menuTarget = await waitFor(async () => (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url === menuUrl), { what: "the toolbar menu" });
          const menu = await attach(cdp, menuTarget.targetId);
          await collector.watch(menu);
          await waitFor(() => evaluate(cdp, menu, "document.querySelectorAll('.menu-item').length > 0"), { what: "the menu items" });
          // No server for this page: the menu says so, and offers the settings.
          const menuProblem = await waitFor(
            () => evaluate(cdp, menu, "(() => { const p = document.getElementById('problem'); return p && !p.hidden ? p.innerText : null; })()"),
            { timeoutMs: 3_000, what: "the menu's 'Not connected' line" },
          ).catch(() => null);
          expect(/^Not connected/.test(menuProblem ?? "") && /localhost:4999/.test(menuProblem ?? "") && /Open settings/.test(menuProblem ?? ""), `menu problem line: ${JSON.stringify(menuProblem)}`);
          const menuWidth = await evaluate(cdp, menu, "document.body.scrollWidth");
          expect(menuWidth <= 260, `the menu is ${menuWidth}px wide with the problem line (should stay 260px)`);
          log(`menu without a server: ${JSON.stringify((menuProblem ?? "").replace(/\s+/g, " "))} (${menuWidth}px wide)`);
          // A real click is a user gesture, which sidePanel.open() needs.
          const { exceptionDetails } = await cdp.send("Runtime.evaluate", {
            expression: "[...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Settings')).click()",
            userGesture: true,
          }, menu);
          if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
          menuOpened = true;
        } catch (error) {
          problems.push(`toolbar menu after the simulated click: ${error.message}`);
        }
      }
      if (menuOpened) {
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
        // Then the width the panel animation ends at: unchanged for 4 polls in a row.
        let lastWidth = -1;
        let stableFor = 0;
        const settledWidth = await waitFor(async () => {
          const w = await evaluate(cdp, page, "innerWidth");
          stableFor = w === lastWidth ? stableFor + 1 : 0;
          lastWidth = w;
          return stableFor >= 4 ? w : null;
        }, { intervalMs: 150, what: "the page width to settle after the side panel opened" });
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
        expect(panels.length > 0, "the menu's Settings item did not open the side panel");
        expect(canCapture === true, `toolbar click did not grant activeTab: ${canCapture}`);
        log(`toolbar click -> menu -> Settings: side panel opened=${panels.length > 0}; activeTab granted=${canCapture === true}`);
      }
      // Grace for a late console error from the last step (collected below).
      await sleep(300);
    } finally {
      fixture.close();
    }

    for (const [name, session] of [["worker", worker.sessionId], ["welcome page", welcome], ["side panel", panel], ["fixture page", page]]) {
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
