#!/usr/bin/env node
/**
 * End-to-end test: the real extension in headless Chrome against the real
 * holt server, mounted in the example Vite app, checked on disk.
 *
 *   1. Build the server (if packages/server/dist is missing) and the extension.
 *   2. Start examples/vite-app with the Vite CLI on a free port
 *      (--port N --strictPort). It runs from a temp copy whose
 *      holt.config.json points outputDir at a temp folder, so nothing is
 *      written into examples/vite-app. `node_modules` in the copy only
 *      contains symlinks to `vite` and `holt`.
 *   3. Load the extension with its default "auto" server mode and a
 *      fallback URL nothing listens on, so every capture below only works
 *      if the extension finds holt on the example page's own origin.
 *      First a loopback page without holt (a plain node server): the
 *      worker falls back, the fallback is down, so the badge is a red "!"
 *      and the toolbar menu says "Not connected" with "Open settings".
 *      Then the example page: the badge clears, `serverInfo` says source
 *      "tab", and the menu's header names the project. Clicking the
 *      toolbar icon (Extensions.triggerAction) opens the real toolbar menu
 *      (menu.html, the action popup) and grants activeTab. Its Quick note
 *      item turns the menu into the note popup about the page (closed with
 *      Esc, nothing saved). Its Settings item opens the side panel, whose
 *      status line says "from this tab".
 *   4. Visible screenshot (command), then Full page and Area from the menu
 *      (dragging with synthetic mouse events in the page). After each, the
 *      note prompt (note.html?mode=screenshot, a popup window) opens and
 *      nothing is written until it is answered: a typed note + Enter, Esc
 *      (skip), closing the window, and a screenshot that is superseded by
 *      the next one (written without a note) whose prompt is answered with
 *      the Save button. While that last prompt is open (and is "the active
 *      tab"), a command run on the prompt's own tab is retargeted to the
 *      example page (an area selection appears there; Esc cancels it). Screenshots go menu/command -> worker -> POST
 *      /media -> prompt -> worker -> POST /entries; the panel lists each
 *      as one item with its file and note.
 *   5. Tab recording from the menu's "Start recording": menu -> worker
 *      (chrome.tabCapture.getMediaStreamId, with no user gesture in the
 *      worker) -> offscreen document (getUserMedia + MediaRecorder) ->
 *      server. While it runs: toolbar badge "REC", the menu offers only
 *      "Stop recording", and the transcript box is on the page; it is gone
 *      afterwards (nobody touched it, so the transcript is saved as is),
 *      and the offscreen document is closed again.
 *   6. Quick note (Alt+T) through the worker's command handler: the action
 *      popup opens with the textarea focused, Enter saves, the popup resets
 *      to the menu so a click opens the menu again.
 *   7. Headless: close the side panel, start a tab recording with the
 *      command, take a screenshot meanwhile and skip its note (badge
 *      flashes "✓", then goes back to "REC"), stop with the command (badge
 *      "✓", then cleared).
 *   8. A second Chrome with fake media devices (--use-fake-device-for-media-stream
 *      breaks tab capture in Chrome 155, hence a separate browser), set to
 *      the "fixed" server mode with the Vite origin (the panel says "fixed URL"): voice
 *      note from the menu (badge "MIC"), a voice note with a microphone id
 *      that doesn't exist (falls back to the default and says so), one
 *      with a microphone picked in the panel's Settings, one whose
 *      transcript is edited in the box on the page and saved after review
 *      (its words become the note; with the default settings no audio is
 *      kept), and one that is discarded after review (nothing written).
 *      Then a screenshot whose note is dictated in the prompt (the mic
 *      button opens the fake microphone; whatever speech recognition makes
 *      of its beeps, the typed text is saved).
 *   9. Check on disk: one session folder; notes.md has a header and entries
 *      1-14 with the right headings, Page links and notes (as blockquotes,
 *      a plain note as a paragraph); the PNGs are valid and
 *      the full-page one is taller than the viewport one; the example's
 *      fixed header appears exactly once in the full-page PNG (pixel
 *      sampling at the header's position in every tile); recordings and
 *      voice notes that kept audio are WebM files. Then SIGTERM Vite and check the
 *      "_Session ended at" footer.
 *  10. Check the cross-origin path: the worker's requests succeed (Chrome's
 *      local/private network checks don't block them), whether Chrome sent a
 *      CORS preflight, and that the server answers a preflight for this
 *      extension's origin.
 *
 * Keyboard shortcuts can't be pressed through the DevTools protocol, so
 * commands are run through the worker's `holtTest.handleCommand` (see
 * background/index.ts). That skips the shortcut's user gesture; everything
 * after it is the real code path.
 *
 * Only processes this script started (by PID) are stopped. Temp dirs are
 * removed even on failure (set KEEP_TEMP=1 to keep them).
 *
 * Usage: pnpm --filter @holt/extension e2e
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
import { colorClose, decodePng, parseCssColor, pngInfo as pngInfoFromBuffer } from "./lib/png.mjs";

const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(EXT_ROOT, "../..");
const DIST = join(EXT_ROOT, "dist");
const EXAMPLE = join(REPO, "examples/vite-app");
const SERVER_PKG = join(REPO, "packages/server");

const log = (...args) => console.log("[e2e]", ...args);

/** Collected assertion failures; the run continues where it can to report more. */
const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  return Boolean(condition);
}
class Fatal extends Error {}
function require_(condition, message) {
  if (!condition) throw new Fatal(message);
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

function run(cmd, args, what) {
  log(`${what}: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (result.status !== 0) throw new Fatal(`${what} failed:\n${result.stdout}\n${result.stderr}`);
}

function build() {
  if (!existsSync(join(SERVER_PKG, "dist/vite.js"))) run("pnpm", ["--filter", "@velvet-thunder/holt", "build"], "building the server");
  run("pnpm", ["--filter", "@holt/extension", "build"], "building the extension");
}

// ---------------------------------------------------------------------------
// Vite (the example app with the holt plugin)
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/** Copy the example app into `appDir`, redirecting holt's outputDir to `outDir`. */
function prepareApp(appDir, outDir) {
  cpSync(EXAMPLE, appDir, {
    recursive: true,
    filter: (src) => !["node_modules", "qa", "dist"].includes(basename(src)) || src === EXAMPLE,
  });
  const config = JSON.parse(readFileSync(join(EXAMPLE, "holt.config.json"), "utf8"));
  config.outputDir = outDir; // absolute: the server resolves it against the root, which keeps it as is
  delete config.$schema; // points into node_modules; not needed here
  writeFileSync(join(appDir, "holt.config.json"), JSON.stringify(config, null, 2));
  // tsconfig.json extends the repo's base config by a relative path, which
  // would not resolve from the temp copy (Vite's esbuild transform reads it):
  // point it at the absolute path instead.
  const tsconfigPath = join(appDir, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    const tsconfig = readFileSync(tsconfigPath, "utf8").replace(
      /("extends"\s*:\s*")(\.[^"]*)(")/,
      (_, a, rel, b) => a + resolve(EXAMPLE, rel) + b,
    );
    writeFileSync(tsconfigPath, tsconfig);
  }
  // Only the two packages vite.config.ts imports, as symlinks to the workspace.
  mkdirSync(join(appDir, "node_modules"));
  for (const name of ["vite", "@velvet-thunder/holt"]) {
    mkdirSync(dirname(join(appDir, "node_modules", name)), { recursive: true });
    symlinkSync(realpathSync(join(EXAMPLE, "node_modules", name)), join(appDir, "node_modules", name), "dir");
  }
  return config;
}

async function startVite(appDir, port) {
  const viteBin = join(appDir, "node_modules/vite/bin/vite.js");
  // Run the Vite CLI with node directly (not via pnpm) so the PID we hold is
  // Vite itself and SIGTERM reaches it; Vite closes the server (and our
  // plugin ends the session) on SIGTERM.
  const proc = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort"], {
    cwd: appDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitFor(
      async () => {
        if (proc.exitCode !== null) throw new Fatal(`Vite exited early (code ${proc.exitCode}):\n${output}`);
        return fetch(origin + "/").then((r) => r.ok, () => false);
      },
      { timeoutMs: 30_000, intervalMs: 200, what: `Vite at ${origin}` },
    );
  } catch (error) {
    proc.kill();
    throw error;
  }
  return { proc, origin, output: () => output };
}

async function stopVite(vite, signal = "SIGTERM") {
  if (!vite || vite.proc.exitCode !== null || vite.proc.signalCode !== null) return;
  const exited = new Promise((r) => vite.proc.once("exit", (code, sig) => r({ code, sig })));
  vite.proc.kill(signal);
  const result = await Promise.race([exited, sleep(10_000).then(() => null)]);
  if (!result) {
    vite.proc.kill("SIGKILL");
    return null;
  }
  return result;
}

// ---------------------------------------------------------------------------
// On-disk checks
// ---------------------------------------------------------------------------

function sessionDirs(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(outDir, d.name));
}

function readNotes(outDir) {
  const [dir] = sessionDirs(outDir);
  const file = dir && join(dir, "notes.md");
  return file && existsSync(file) ? readFileSync(file, "utf8") : "";
}

function entryCount(notes) {
  return (notes.match(/^## \d+\. /gm) ?? []).length;
}

/** Validate PNG signature and read IHDR width/height. */
function pngInfo(file) {
  return pngInfoFromBuffer(readFileSync(file));
}

/** Split notes.md into entry blocks keyed by number. */
function parseEntries(notes) {
  const blocks = notes.split(/^(?=## \d+\. )/m).slice(1);
  return blocks.map((block) => {
    const m = block.match(/^## (\d+)\. (.+?) · (\d\d:\d\d:\d\d)\n/);
    const image = block.match(/!\[[^\]]*\]\(\.\/([^)]+)\)/);
    const page = block.match(/^Page: \[(.+)\]\(([^)]+)\)$/m);
    return { seq: m ? Number(m[1]) : NaN, label: m?.[2], image: image?.[1], pageTitle: page?.[1], pageUrl: page?.[2], block };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---- the toolbar menu (menu.html, the action popup) --------------------------

/** Menus opened in the first Chrome, checked for console errors at the end. */
const menuSessions = [];

/** Click the toolbar icon on `url`'s tab and attach to the menu it opens. */
async function openMenu(cdpX, extensionId, url, collectorX) {
  const menuUrl = `chrome-extension://${extensionId}/menu.html`;
  const isMenu = async () => (await cdpX.send("Target.getTargets")).targetInfos.find((t) => t.url === menuUrl);
  // A menu that is still closing would be found instead of the new one.
  await waitFor(async () => !(await isMenu()), { timeoutMs: 5_000, what: "the previous menu to close" });
  await clickToolbarIcon(cdpX, extensionId, url);
  const target = await waitFor(isMenu, { what: "the toolbar menu to open" });
  const session = await attach(cdpX, target.targetId);
  await collectorX.watch(session);
  if (cdpX === cdp) menuSessions.push(session);
  await waitFor(() => evaluate(cdpX, session, "document.querySelectorAll('.menu-item').length > 0"), { what: "the menu to render its items" });
  return session;
}

function menuItems(cdpX, session) {
  return evaluate(cdpX, session, "[...document.querySelectorAll('.menu-item .menu-label')].map(e => e.textContent)");
}

/** Click a menu item as the user would (with a user gesture, which sidePanel.open() needs). */
async function clickMenuItem(cdpX, session, label) {
  const { exceptionDetails } = await cdpX.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const b = [...document.querySelectorAll('.menu-item')].find(b => b.querySelector('.menu-label').textContent === ${JSON.stringify(label)});
        if (!b) throw new Error('no menu item ' + ${JSON.stringify(label)});
        b.click();
      })()`,
      userGesture: true,
    },
    session,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
}

// ---- the transcript box on the page (closed shadow root) ----------------------

/**
 * Run `fn` (a function declaration) with `this` = the transcript box's shadow
 * root. Page scripts can't reach a closed shadow root; the DevTools
 * protocol can (DOM.getDocument with pierce). Returns null if there is no box.
 */
async function inTranscriptBox(cdpX, session, fn, ...args) {
  const { root } = await cdpX.send("DOM.getDocument", { depth: -1, pierce: true }, session);
  const find = (node) => (node.localName === "holt-voice-overlay" ? node : (node.children ?? []).reduce((hit, child) => hit ?? find(child), null));
  const shadow = find(root)?.shadowRoots?.[0];
  if (!shadow) return null;
  const { object } = await cdpX.send("DOM.resolveNode", { backendNodeId: shadow.backendNodeId }, session);
  const { result, exceptionDetails } = await cdpX.send(
    "Runtime.callFunctionOn",
    { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true, userGesture: true },
    session,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value ?? null;
}

// ---- the screenshot note prompt (note.html?mode=screenshot, a popup window) ----

/** Prompts opened in the first Chrome, checked for console errors at the end. */
const promptSessions = [];

/** Wait for the note prompt of a new screenshot (not `previous`) and attach to it. */
async function screenshotPrompt(cdpX, collectorX, previous) {
  const target = await waitFor(
    async () => (await cdpX.send("Target.getTargets")).targetInfos.find((t) => t.url.includes("/note.html?mode=screenshot") && t.targetId !== previous),
    { what: "the screenshot note prompt" },
  );
  const session = await attach(cdpX, target.targetId);
  await collectorX.watch(session);
  if (cdpX === cdp) promptSessions.push(session);
  // Headless windows aren't focused; without this, focus() fires no focus event.
  await cdpX.send("Emulation.setFocusEmulationEnabled", { enabled: true }, session);
  await waitFor(() => evaluate(cdpX, session, "document.readyState === 'complete' && document.getElementById('page').textContent.startsWith('Note on:')"), {
    what: "the prompt to show the screenshot's page",
  });
  return { session, targetId: target.targetId };
}

function promptGone(cdpX, targetId) {
  return waitFor(async () => !(await cdpX.send("Target.getTargets")).targetInfos.some((t) => t.targetId === targetId), {
    timeoutMs: 5_000,
    what: "the note prompt to close",
  });
}

async function pressKey(cdpX, session, key) {
  const codes = { Enter: 13, Escape: 27 };
  for (const type of ["keyDown", "keyUp"]) {
    await cdpX.send(
      "Input.dispatchKeyEvent",
      { type, key, code: key, windowsVirtualKeyCode: codes[key], ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}) },
      session,
    );
  }
}

/** Type `text` into the prompt's textarea (focused first, as the user's cursor would be). */
async function typeInPrompt(cdpX, session, text) {
  await evaluate(cdpX, session, "document.getElementById('text').focus()");
  await cdpX.send("Input.insertText", { text }, session);
}

/**
 * A loopback page that is not holt: like most dev servers, it answers
 * unknown paths (including /__holt/status) with a 404 page.
 */
function startPlainServer() {
  const server = createHttpServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Not holt (e2e)</title><h1>A dev server without holt</h1>");
    } else {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>404</title>Not found");
    }
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => res(server)));
}

const temp = mkdtempSync(join(tmpdir(), "holt-e2e-"));
const appDir = join(temp, "app");
const outDir = join(temp, "out");
let vite;
let chrome;
let cdp;
let chromeB;
let cdpB;
let notesAtEnd = "";
let plain;

async function cleanup() {
  plain?.close();
  cdp?.close();
  cdpB?.close();
  await stopChrome(chrome).catch(() => undefined);
  await stopChrome(chromeB).catch(() => undefined);
  await stopVite(vite, "SIGKILL").catch(() => undefined); // no-op if it already exited
  if (process.env.KEEP_TEMP) log(`keeping temp dir ${temp}`);
  else rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => {
    log(`${sig}: cleaning up`);
    void cleanup().finally(() => process.exit(130));
  });
}

try {
  build();

  // ---- server ---------------------------------------------------------------
  const config = prepareApp(appDir, outDir);
  const port = await freePort();
  vite = await startVite(appDir, port);
  const origin = vite.origin;
  const pageUrl = `${origin}/`;
  log(`Vite + holt plugin at ${origin}, writing to ${outDir}`);

  // ---- browser ----------------------------------------------------------------
  // A desktop-sized window: the side panel takes ~1/3 of it once open.
  chrome = await launchChrome({ headless: true, extensionDir: DIST, extraArgs: ["--window-size=1280,900"] });
  cdp = await Cdp.connect(chrome.wsUrl);
  const collector = errorCollector(cdp);
  const worker = await loadExtension(cdp, DIST, collector, { log });
  require_(worker, "the extension's service worker never started (headless Chrome)");
  log(`extension ${worker.extensionId} loaded (${worker.method})`);

  // Watch the network from the worker and (later) the panel: which requests
  // were made to /__holt, any CORS preflight, any blocked request.
  const requests = new Map(); // requestId -> { method, url, status, failed, blocked, from }
  cdp.on((msg) => {
    const p = msg.params;
    if (msg.method === "Network.requestWillBeSent" && p.request.url.includes("/__holt")) {
      requests.set(p.requestId, { method: p.request.method, url: p.request.url, from: msg.sessionId });
    } else if (msg.method === "Network.responseReceived" && requests.has(p.requestId)) {
      requests.get(p.requestId).status = p.response.status;
    } else if (msg.method === "Network.loadingFailed" && requests.has(p.requestId)) {
      Object.assign(requests.get(p.requestId), { failed: p.errorText, blocked: p.blockedReason ?? p.corsErrorStatus?.corsError });
    }
  });
  await cdp.send("Network.enable", {}, worker.sessionId);

  // Default mode ("auto"); the fallback URL is a port nothing listens on.
  const deadFallback = `http://127.0.0.1:${await freePort()}`;
  await evaluate(cdp, worker.sessionId, `chrome.storage.local.set({ serverUrl: ${JSON.stringify(deadFallback)} })`);
  const ev0 = (expr) => evaluate(cdp, worker.sessionId, expr);
  const serverInfo = () => ev0("chrome.storage.session.get('serverInfo').then(s => s.serverInfo ?? null)");
  const badgeNow = () => ev0("Promise.all([chrome.action.getBadgeText({}), chrome.action.getTitle({})]).then(([text, title]) => ({ text, title }))");

  // ---- no holt on this page, none at the fallback: red "!", the menu explains ----
  plain = await startPlainServer();
  const plainUrl = `http://127.0.0.1:${plain.address().port}/`;
  const { targetId: plainTarget } = await cdp.send("Target.createTarget", { url: plainUrl });
  await cdp.send("Target.activateTarget", { targetId: plainTarget });
  const noServer = await waitFor(async () => {
    const [info, b] = await Promise.all([serverInfo(), badgeNow()]);
    return info?.localPage && info.ok === false && b.text === "!" ? { info, b } : null;
  }, { timeoutMs: 10_000, what: "the red '!' badge on a loopback page without holt" }).catch((e) => (check(false, e.message), null));
  if (noServer) {
    check(noServer.info.source === "fallback" && noServer.info.serverUrl === deadFallback, `serverInfo on the plain page: ${JSON.stringify(noServer.info)}`);
    check(noServer.b.title.startsWith(`holt: no server for this page — Can't reach the holt server at ${deadFallback}`), `badge tooltip on the plain page: ${noServer.b.title}`);
  }
  const plainMenu = await openMenu(cdp, worker.extensionId, plainUrl, collector);
  const plainProblem = await waitFor(
    () => evaluate(cdp, plainMenu, "(() => { const p = document.getElementById('problem'); return p && !p.hidden ? p.innerText : null; })()"),
    { timeoutMs: 5_000, what: "the menu's 'Not connected' line on the plain page" },
  ).catch((e) => (check(false, e.message), ""));
  check(/^Not connected/.test(plainProblem) && plainProblem.includes("No holt on this page") && plainProblem.includes(deadFallback.replace("http://", "")) && /Open settings/.test(plainProblem),
    `menu problem line on the plain page: ${JSON.stringify(plainProblem)}`);
  const plainItems = await menuItems(cdp, plainMenu);
  check(plainItems.includes("Screenshot area") && plainItems.includes("Settings"), `menu items without a server: ${JSON.stringify(plainItems)}`);
  await evaluate(cdp, plainMenu, "window.close()").catch(() => undefined);
  log(`no holt on ${plainUrl}, fallback down: badge "${noServer?.b.text}", menu ${JSON.stringify(plainProblem.replace(/\s+/g, " ").slice(0, 120))}`);

  const { targetId: pageTarget } = await cdp.send("Target.createTarget", { url: pageUrl });
  const page = await attach(cdp, pageTarget);
  await collector.watch(page);
  await waitFor(() => evaluate(cdp, page, "document.readyState === 'complete' && !!document.querySelector('.site-header')"), {
    what: "the example page to load",
  });
  // Vite shows compile errors as an overlay element instead of failing the
  // load; the example's script must have run (it fills in #features).
  const viteOverlay = () => evaluate(cdp, page, "document.querySelector('vite-error-overlay')?.shadowRoot?.textContent?.trim().slice(0, 300) ?? ''");
  require_(!(await viteOverlay()), `the example app shows a Vite error overlay: ${await viteOverlay()}`);
  await waitFor(() => evaluate(cdp, page, "document.querySelector('#features')?.children.length > 0"), {
    what: "the example app's script to render #features",
  });

  // ---- the example page: holt found on its own origin; badge clears ------------
  await cdp.send("Target.activateTarget", { targetId: pageTarget });
  const found = await waitFor(async () => {
    const [info, b] = await Promise.all([serverInfo(), badgeNow()]);
    return info?.ok && b.text === "" ? { info, b } : null;
  }, { timeoutMs: 10_000, what: "the badge to clear on the example page (holt auto-detected)" }).catch((e) => (check(false, e.message), null));
  if (found) {
    check(found.info.source === "tab" && found.info.serverUrl === origin && found.info.localPage, `serverInfo on the example page: ${JSON.stringify(found.info)}`);
    check(found.info.project && found.b.title === `holt (${found.info.project})`, `tooltip on the example page: ${found.b.title}`);
  }
  await cdp.send("Target.closeTarget", { targetId: plainTarget });

  // Toolbar click: opens the real menu (and grants activeTab); its Settings item opens the side panel.
  const menu = await openMenu(cdp, worker.extensionId, pageUrl, collector);
  const menuHeader = await waitFor(
    () => evaluate(cdp, menu, "(() => { const t = document.getElementById('project').textContent; return t && document.getElementById('problem').hidden ? t : null; })()"),
    { timeoutMs: 5_000, what: "the menu header to name the example's project" },
  ).catch((e) => (check(false, e.message), null));
  check(found && menuHeader === found.info.project, `menu header: ${JSON.stringify(menuHeader)} (serverInfo project ${found?.info.project})`);
  log(`auto-detected holt at ${origin} (source "${found?.info.source}"): badge "${found?.b.text}", tooltip "${found?.b.title}", menu header "${menuHeader}"`);
  const idleItems = await menuItems(cdp, menu);
  check(
    JSON.stringify(idleItems) ===
      JSON.stringify(["Screenshot area", "Screenshot viewport", "Screenshot full page", "Voice note", "Quick note", "Start recording", "Settings"]),
    `unexpected menu items: ${JSON.stringify(idleItems)}`,
  );
  log(`toolbar menu: ${idleItems.join(" · ")}`);

  // The menu's Quick note: the menu itself becomes the note popup, about the
  // page and its server (nothing is saved here: Esc closes it).
  await clickMenuItem(cdp, menu, "Quick note");
  const menuNoteTitle = await evaluate(cdp, page, "document.title");
  // A fresh session on the (same) popup target: the old one's context went with the menu document.
  const menuNoteTarget = await waitFor(async () => (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url.includes("/note.html")), {
    what: "the menu to turn into the quick note",
  });
  const menuNoteSession = await attach(cdp, menuNoteTarget.targetId);
  await collector.watch(menuNoteSession);
  const menuNote = await waitFor(
    () => evaluate(cdp, menuNoteSession, "document.readyState === 'complete' && document.getElementById('page').textContent.startsWith('Note on:') ? { page: document.getElementById('page').textContent } : null"),
    { what: "the quick note (from the menu) to show its page" },
  ).catch((e) => (check(false, e.message), null));
  check(menuNote?.page === `Note on: ${menuNoteTitle}`, `quick note from the menu is not about the example page: ${JSON.stringify(menuNote)}`);
  const menuNoteServer = await evaluate(cdp, worker.sessionId, "chrome.storage.session.get('noteContext').then(s => s.noteContext?.serverUrl ?? null)");
  check(menuNoteServer === origin, `quick note from the menu resolved to ${menuNoteServer}, expected ${origin}`);
  await evaluate(cdp, menuNoteSession, "document.getElementById('text').focus()").catch(() => undefined);
  // Only the keydown: the quick note closes on it, and a keyup sent to the
  // closed popup would never be answered.
  void cdp
    .send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, menuNoteSession)
    .catch(() => undefined);
  await waitFor(async () => !(await cdp.send("Target.getTargets")).targetInfos.some((t) => t.url.includes("/note.html")), {
    timeoutMs: 5_000,
    what: "the quick note (from the menu) to close on Esc",
  }).catch((e) => check(false, e.message));
  check((await evaluate(cdp, worker.sessionId, "chrome.action.getPopup({})")).endsWith("/menu.html"), "the action popup is not the menu after the menu's quick note");
  log(`menu Quick note: became the note popup (${JSON.stringify(menuNote?.page)}, server ${menuNoteServer}); Esc closed it`);

  const settingsMenu = await openMenu(cdp, worker.extensionId, pageUrl, collector);
  await clickMenuItem(cdp, settingsMenu, "Settings");
  const panelUrl = `chrome-extension://${worker.extensionId}/sidepanel.html`;
  const panelTarget = await waitFor(
    async () => (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url === panelUrl),
    { what: "the side panel to open from the menu's Settings item" },
  );
  const panel = await attach(cdp, panelTarget.targetId);
  await collector.watch(panel);
  await cdp.send("Network.enable", {}, panel);
  const serverLine = await waitFor(
    async () => {
      const text = await evaluate(cdp, panel, "document.querySelector('.server-line')?.innerText ?? ''");
      return /holt .*· /.test(text) ? text : null;
    },
    { timeoutMs: 15_000, what: "the side panel to report the server as reachable" },
  );
  log(`side panel connected: "${serverLine.replace(/\s+/g, " ").trim()}"`);
  check(serverLine.includes(`${origin.replace("http://", "")} · from this tab`), `the panel does not say the server came from this tab: ${JSON.stringify(serverLine)}`);
  const sections = await evaluate(cdp, panel, "[...document.querySelectorAll('main > section')].map(s => s.id).join(',')");
  check(sections === "status,entries,settings", `settings panel sections: ${sections} (expected status,entries,settings)`);
  const project = await evaluate(cdp, panel, "document.querySelector('.server-line .project')?.textContent ?? null");
  log(project ? `server reports project "${project}"` : "server does not report a project name (older server build); panel shows version and host only");

  // Opening the side panel animates and shrinks the page's viewport. Wait
  // until its width has stopped changing, or captures race the resize.
  let lastWidth = -1;
  let stableFor = 0;
  await waitFor(
    async () => {
      const w = await evaluate(cdp, page, "innerWidth");
      stableFor = w === lastWidth ? stableFor + 1 : 0;
      lastWidth = w;
      return stableFor >= 4;
    },
    { intervalMs: 150, what: "the page viewport to settle after the side panel opened" },
  );

  /** Open the menu on the example page and pick `label`. */
  const fromMenu = async (label) => clickMenuItem(cdp, await openMenu(cdp, worker.extensionId, pageUrl, collector), label);
  const pageCommand = (name) =>
    evaluate(cdp, worker.sessionId, `chrome.tabs.query({}).then(ts => ts.find(t => t.url === ${JSON.stringify(pageUrl)})).then(t => { holtTest.handleCommand(${JSON.stringify(name)}, t); return true; })`);
  const waitForEntries = (n, what) =>
    waitFor(() => entryCount(readNotes(outDir)) >= n, { timeoutMs: 30_000, intervalMs: 200, what });
  const panelToasts = () => evaluate(cdp, panel, "document.getElementById('toasts').innerText").catch(() => "");
  const pendingShot = () => evaluate(cdp, worker.sessionId, "chrome.storage.session.get('pendingScreenshot').then(s => s.pendingScreenshot ?? null)");
  const exampleTitle = await evaluate(cdp, page, "document.title");

  /** Page viewport (CSS px) and DPR right before each capture: PNG sizes must match. */
  const viewports = {};
  const pageViewport = () => evaluate(cdp, page, "({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })");

  // ---- 1. viewport screenshot, typed note, Enter ----------------------------------
  const shotNote = "Submit button overlaps the footer (e2e).";
  viewports["Screenshot"] = await pageViewport();
  await pageCommand("screenshot-viewport"); // not in the menu; a shortcut
  const prompt1 = await screenshotPrompt(cdp, collector);
  const prompt1Info = await evaluate(cdp, prompt1.session, `({
    page: document.getElementById('page').textContent,
    focused: document.activeElement?.id ?? null,
    mic: !document.getElementById('mic').hidden,
    skip: !document.getElementById('skip').hidden,
  })`);
  check(prompt1Info.page === `Note on: ${exampleTitle}`, `screenshot prompt is not about the example page ("${exampleTitle}"): ${prompt1Info.page}`);
  check(prompt1Info.focused === "text", `screenshot prompt textarea not focused (activeElement: ${prompt1Info.focused})`);
  check(prompt1Info.skip, "screenshot prompt has no Skip button");
  check((await pendingShot())?.file === "001-screenshot.png", `pendingScreenshot while the prompt is open: ${JSON.stringify(await pendingShot())}`);
  check((await pendingShot())?.serverUrl === origin, `the pending screenshot is not pinned to the server it was uploaded to: ${JSON.stringify(await pendingShot())}`);
  check(entryCount(readNotes(outDir)) === 0, "the screenshot entry was written before the prompt was answered");
  await typeInPrompt(cdp, prompt1.session, shotNote);
  await pressKey(cdp, prompt1.session, "Enter");
  await waitForEntries(1, `entry 1 (viewport screenshot). Panel says: ${await panelToasts()}`);
  await promptGone(cdp, prompt1.targetId).catch((e) => check(false, e.message));
  check((await pendingShot()) === null, "pendingScreenshot not cleared after Save");
  const panelItem = await waitFor(
    () => evaluate(cdp, panel, "document.querySelector('#entries li')?.innerText ?? null"),
    { what: "the panel to list the screenshot" },
  );
  check(panelItem.includes("001-screenshot.png") && panelItem.includes(shotNote), `panel item for the screenshot lacks its file or note: ${JSON.stringify(panelItem)}`);
  check(!(await evaluate(cdp, panel, "!!document.querySelector('#entries input')")), "the panel's entry list still has a note input");
  log(`1/14 viewport screenshot written with its note (prompt: "${prompt1Info.page}", mic button shown=${prompt1Info.mic})`);

  // ---- 2. full-page screenshot ------------------------------------------------
  viewports["Screenshot (full page)"] = await pageViewport();
  // Where the fixed header's "Checkout" button is (viewport CSS px) and its
  // colour: sampled in the stitched PNG to prove the header appears once.
  // x is 4px into the button's left padding, so we hit background, not text.
  const headerProbe = await evaluate(cdp, page, `(() => {
    const button = document.querySelector('.site-header .button');
    const r = button.getBoundingClientRect();
    return { x: r.left + 4, y: r.top + r.height / 2, color: getComputedStyle(button).backgroundColor,
             position: getComputedStyle(document.querySelector('.site-header')).position };
  })()`);
  require_(headerProbe.position === "fixed", `the example's .site-header is no longer position: fixed (${headerProbe.position})`);
  await fromMenu("Screenshot full page");
  const prompt2 = await screenshotPrompt(cdp, collector, prompt1.targetId);
  await pressKey(cdp, prompt2.session, "Escape"); // Skip
  await waitForEntries(2, "entry 2 (full-page screenshot)");
  await promptGone(cdp, prompt2.targetId).catch((e) => check(false, e.message));
  const headerAfter = await evaluate(cdp, page, "(() => { const h = document.querySelector('.site-header'); return getComputedStyle(h).visibility + '|' + h.style.cssText; })()");
  check(headerAfter === "visible|", `the fixed header was not restored after the capture (visibility|inline style = ${headerAfter})`);
  const scrollAfter = await evaluate(cdp, page, "scrollY");
  check(scrollAfter === 0, `full-page capture did not restore the scroll position (scrollY=${scrollAfter})`);
  log("2/14 full-page screenshot written (from the menu; note skipped with Esc)");

  // ---- 3. area screenshot: real overlay, synthetic drag ------------------------
  viewports["Screenshot (area)"] = await pageViewport();
  await fromMenu("Screenshot area");
  await waitFor(() => evaluate(cdp, page, "!!document.querySelector('holt-area-select')"), { what: "the area-select overlay" });
  // 200 x 150 CSS px, kept inside the viewport (the overlay clamps to it).
  const viewportWidth = await evaluate(cdp, page, "innerWidth");
  require_(viewportWidth >= 260, `page viewport is only ${viewportWidth}px wide`);
  const drag = { x0: 40, y0: 120, x1: 240, y1: 270 };
  const mouse = (type, x, y) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }, page);
  await mouse("mousePressed", drag.x0, drag.y0);
  for (let i = 1; i <= 5; i++) await mouse("mouseMoved", drag.x0 + ((drag.x1 - drag.x0) * i) / 5, drag.y0 + ((drag.y1 - drag.y0) * i) / 5);
  await mouse("mouseReleased", drag.x1, drag.y1);
  const prompt3 = await screenshotPrompt(cdp, collector, prompt2.targetId);
  await sleep(300);
  check(entryCount(readNotes(outDir)) === 2, "the area screenshot was written before its prompt was answered");
  await cdp.send("Target.closeTarget", { targetId: prompt3.targetId }); // the user closes the window: same as Skip
  await waitForEntries(3, "entry 3 (area screenshot, prompt window closed)");
  check((await pendingShot()) === null, "pendingScreenshot not cleared after the prompt window was closed");
  log("3/14 area screenshot written (from the menu; prompt window closed, so no note)");

  // ---- 4. a second screenshot while the first one's prompt is open --------------------
  const savedNote = "Saved with the button (e2e).";
  await pageCommand("screenshot-viewport");
  const prompt4 = await screenshotPrompt(cdp, collector, prompt3.targetId);
  await pageCommand("screenshot-viewport");
  // The pending one is written without a note, its prompt closes, and a new one opens.
  await waitForEntries(4, "entry 4 (screenshot superseded by the next one)");
  await promptGone(cdp, prompt4.targetId).catch((e) => check(false, e.message));
  const prompt5 = await screenshotPrompt(cdp, collector, prompt4.targetId);

  // A shortcut pressed while the prompt is in front (it opens focused) gets
  // the prompt's own tab as "the active tab": it must act on the page the
  // screenshot was taken of instead. Area selection leaves no entry: the
  // overlay appears on the example page, Esc there cancels it.
  const pendingBefore = await pendingShot();
  const pageTabId = await evaluate(cdp, worker.sessionId, `chrome.tabs.query({}).then(ts => ts.find(t => t.url === ${JSON.stringify(pageUrl)})?.id ?? null)`);
  const promptTab = await evaluate(cdp, worker.sessionId, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url ?? "").includes("/note.html?mode=screenshot")) ?? null)`);
  check(promptTab !== null, "the worker can't see the note prompt's tab URL (needed to retarget shortcuts)");
  await evaluate(cdp, worker.sessionId, `chrome.tabs.query({}).then(ts => ts.find(t => (t.url ?? "").includes("/note.html?mode=screenshot"))).then(t => { holtTest.handleCommand("screenshot-area", t); return true; })`);
  const retargeted = await waitFor(
    async () => (await evaluate(cdp, page, "!!document.querySelector('holt-area-select')")) && (await evaluate(cdp, worker.sessionId, "chrome.storage.session.get('pendingArea').then(s => s.pendingArea ?? null)")),
    { timeoutMs: 5_000, what: "Alt+S pressed in the note prompt to start an area selection on the example page" },
  ).catch((e) => (check(false, e.message), null));
  check(retargeted?.tabId === pageTabId, `a command from the prompt went to tab ${retargeted?.tabId}, not the example page's ${pageTabId}`);
  await cdp.send("Page.bringToFront", {}, page);
  await pressKey(cdp, page, "Escape");
  await waitFor(async () => !(await evaluate(cdp, page, "!!document.querySelector('holt-area-select')")), { timeoutMs: 5_000, what: "Esc to cancel the retargeted area selection" })
    .catch((e) => check(false, e.message));
  check((await pendingShot())?.id === pendingBefore?.id, `the retargeted command disturbed the pending screenshot: ${JSON.stringify(await pendingShot())}`);
  log(`a command run with the note prompt as the active tab went to the example page (area overlay on tab ${retargeted?.tabId}); cancelled`);

  await typeInPrompt(cdp, prompt5.session, savedNote);
  await evaluate(cdp, prompt5.session, "document.getElementById('save').click()");
  await waitForEntries(5, "entry 5 (screenshot saved with the Save button)");
  await promptGone(cdp, prompt5.targetId).catch((e) => check(false, e.message));
  log("4-5/14 a screenshot taken while a prompt was open wrote the pending one without a note; the new one saved with the button");

  // Helpers for the recorder steps.
  const ev = (expr) => evaluate(cdp, worker.sessionId, expr);
  const badge = () => ev("Promise.all([chrome.action.getBadgeText({}), chrome.action.getTitle({})]).then(([text, title]) => ({ text, title }))");
  const pageTab = `chrome.tabs.query({}).then(ts => ts.find(t => t.url === ${JSON.stringify(pageUrl)}))`;
  const command = (name) => ev(`${pageTab}.then(t => { holtTest.handleCommand(${JSON.stringify(name)}, t); return true; })`);
  const offscreenOpen = async () => (await cdp.send("Target.getTargets")).targetInfos.some((t) => t.url.endsWith("/offscreen.html"));
  const watchOffscreen = async () => {
    const target = (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url.endsWith("/offscreen.html"));
    if (!target) return null;
    const session = await attach(cdp, target.targetId);
    await collector.watch(session);
    offscreenSessions.push(session);
    return session;
  };
  const offscreenSessions = [];

  // ---- 5. tab recording from the menu ----------------------------------------------
  const transcriptBox = () => evaluate(cdp, page, "!!document.querySelector('holt-voice-overlay')");
  await fromMenu("Start recording");
  const recBadge = await waitFor(async () => {
    const b = await badge();
    return b.text === "REC" ? b : null;
  }, { what: `the REC badge. Panel says: ${await panelToasts()}` });
  check(/recording tab since \d\d:\d\d/.test(recBadge.title), `unexpected tooltip while recording: ${recBadge.title}`);
  check(await offscreenOpen(), "no offscreen document while recording");
  await watchOffscreen();
  await waitFor(transcriptBox, { what: "the transcript box on the page during the recording" }).catch((e) => check(false, e.message));
  const recMenu = await openMenu(cdp, worker.extensionId, pageUrl, collector);
  const recItems = await menuItems(cdp, recMenu);
  check(JSON.stringify(recItems) === JSON.stringify(["Stop recording"]), `menu while recording: ${JSON.stringify(recItems)}`);
  log(`6/14 tab recording running: badge ${recBadge.text}, tooltip "${recBadge.title}", menu ${JSON.stringify(recItems)}, transcript box shown`);
  await sleep(2_000);
  await clickMenuItem(cdp, recMenu, "Stop recording");
  await waitForEntries(6, `entry 6 (tab recording). Panel says: ${await panelToasts()}`);
  check((await badge()).text === "", `badge not cleared after the recording: ${JSON.stringify(await badge())}`);
  check(!(await transcriptBox()), "the (untouched) transcript box is still on the page after the recording was saved");
  await waitFor(async () => !(await offscreenOpen()), { timeoutMs: 8_000, what: "the offscreen document to close when idle" }).catch((e) => check(false, e.message));
  log("6/14 tab recording written; badge cleared; transcript box gone; offscreen document closed");

  // ---- 6. quick note popup (Alt+T) --------------------------------------------------
  const popupNote = "Saved from the Alt+T popup (e2e).";
  await command("quick-note");
  const noteTarget = await waitFor(async () => (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url.includes("/note.html")), {
    what: "the note popup",
  });
  const note = await attach(cdp, noteTarget.targetId);
  await collector.watch(note);
  await waitFor(() => evaluate(cdp, note, "document.readyState === 'complete' && document.getElementById('page').textContent.startsWith('Note on:')"), { what: "the note popup to load its page context" });
  const focused = await evaluate(cdp, note, "document.activeElement?.id ?? null");
  check(focused === "text", `note popup textarea not focused (activeElement: ${focused})`);
  const popupMode = noteTarget.url.includes("window=1") ? "fallback popup window" : "action popup";
  const popupPage = await evaluate(cdp, note, "document.getElementById('page').textContent");
  check(popupPage === `Note on: ${exampleTitle}`, `note popup is not attached to the example page ("${exampleTitle}"): ${popupPage}`);
  const noteServer = await waitFor(() => ev("chrome.storage.session.get('noteContext').then(s => s.noteContext?.serverUrl ?? null)"), { what: "the quick note's server in noteContext" })
    .catch((e) => (check(false, e.message), null));
  check(noteServer === origin, `quick note resolved to ${noteServer}, expected the example's origin ${origin}`);
  check((await ev("chrome.action.getPopup({})")).endsWith("/menu.html"), "the action popup was not reset to the menu after the note popup opened");
  check(await evaluate(cdp, note, "document.getElementById('mic').hidden && document.getElementById('skip').hidden"), "the quick note shows the screenshot prompt's Dictate/Skip buttons");
  await cdp.send("Input.insertText", { text: popupNote }, note);
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, note);
  }
  await waitForEntries(7, "entry 7 (note from the popup)");
  await waitFor(async () => (await panelToasts()).includes("Note #7 saved"), { what: "the panel to announce the popup's note" }).catch((e) => check(false, e.message));
  log(`7/14 popup note written (${popupMode}, textarea focused=${focused === "text"}, "${popupPage}")`);

  // ---- 7. headless: panel closed --------------------------------------------------------
  await cdp.send("Target.closeTarget", { targetId: panelTarget.targetId });
  await waitFor(async () => !(await cdp.send("Target.getTargets")).targetInfos.some((t) => t.url === panelUrl), { what: "the side panel to close" });
  await command("toggle-recording");
  await waitFor(async () => (await badge()).text === "REC", { what: "REC badge from the toggle-recording command" });
  await watchOffscreen();
  await sleep(1_000);
  await command("screenshot-viewport");
  const prompt8 = await screenshotPrompt(cdp, collector, prompt5.targetId);
  await evaluate(cdp, prompt8.session, "document.getElementById('skip').click()");
  await waitForEntries(8, "entry 8 (screenshot while recording, panel closed, note skipped)");
  const flash = await waitFor(async () => {
    const b = await badge();
    return b.text === "✓" ? b : null;
  }, { timeoutMs: 3_000, what: "the ✓ flash for a headless screenshot" }).catch((e) => (check(false, e.message), null));
  const restored = await waitFor(async () => {
    const b = await badge();
    return b.text === "REC" ? b : null;
  }, { timeoutMs: 6_000, what: "the REC badge to come back after the ✓ flash" }).catch((e) => (check(false, e.message), null));
  log(`8/14 headless screenshot while recording (Skip): badge ${flash?.text} then ${restored?.text}`);
  await command("toggle-recording");
  await waitForEntries(9, "entry 9 (tab recording stopped by command, panel closed)");
  const afterStop = await waitFor(async () => {
    const b = await badge();
    return b.text === "✓" || b.text === "" ? b : null;
  }, { what: "the badge after the headless recording" });
  await waitFor(async () => (await badge()).text === "", { timeoutMs: 6_000, what: "the badge to clear" }).catch((e) => check(false, e.message));
  check(!/recording/.test((await badge()).title), `tooltip still says recording: ${(await badge()).title}`);
  log(`9/14 headless tab recording written (badge "${afterStop.text}" then cleared)`);

  // ---- 8. voice notes: a second Chrome with fake media devices -------------------------
  chromeB = await launchChrome({
    headless: true,
    extensionDir: DIST,
    extraArgs: ["--window-size=1280,900", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  cdpB = await Cdp.connect(chromeB.wsUrl);
  const collectorB = errorCollector(cdpB);
  const workerB = await loadExtension(cdpB, DIST, collectorB, { log });
  require_(workerB, "the extension's service worker never started in the second Chrome");
  const evB = (expr) => evaluate(cdpB, workerB.sessionId, expr);
  // This browser uses the "fixed" mode: no probing, always this URL.
  await evB(`chrome.storage.local.set({ serverMode: "fixed", serverUrl: ${JSON.stringify(origin)} })`);
  const { targetId: pageTargetB } = await cdpB.send("Target.createTarget", { url: pageUrl });
  const pageB = await attach(cdpB, pageTargetB);
  await collectorB.watch(pageB);
  await waitFor(() => evaluate(cdpB, pageB, "document.readyState === 'complete'"), { what: "the example page in the second Chrome" });
  const menuB = () => openMenu(cdpB, workerB.extensionId, pageUrl, collectorB);
  await clickMenuItem(cdpB, await menuB(), "Settings");
  const panelB = await attach(cdpB, (await waitFor(
    async () => (await cdpB.send("Target.getTargets")).targetInfos.find((t) => t.url === panelUrl.replace(worker.extensionId, workerB.extensionId)),
    { what: "the side panel in the second Chrome" },
  )).targetId);
  await collectorB.watch(panelB);
  const badgeB = () => evB("chrome.action.getBadgeText({})");
  const toastsB = () => evaluate(cdpB, panelB, "document.getElementById('toasts').innerText").catch(() => "");
  const commandB = (name) => evB(`chrome.tabs.query({}).then(ts => ts.find(t => t.url === ${JSON.stringify(pageUrl)})).then(t => { holtTest.handleCommand(${JSON.stringify(name)}, t); return true; })`);
  const offscreenB = async () => {
    const target = (await cdpB.send("Target.getTargets")).targetInfos.find((t) => t.url.endsWith("/offscreen.html"));
    if (target) {
      const session = await attach(cdpB, target.targetId);
      await collectorB.watch(session);
      offscreenSessionsB.push(session);
    }
  };
  const offscreenSessionsB = [];
  const lineB = await waitFor(async () => {
    const text = await evaluate(cdpB, panelB, "document.querySelector('.server-line')?.innerText ?? ''");
    return /holt .*· /.test(text) ? text : null;
  }, { what: "panel B to connect" });
  check(lineB.includes("· fixed URL"), `panel B (fixed mode) does not say "fixed URL": ${JSON.stringify(lineB)}`);
  const infoB = await evB("chrome.storage.session.get(['serverInfo', 'serverProbes']).then(s => s)");
  check(infoB.serverInfo?.source === "fixed" && infoB.serverInfo?.ok === true, `serverInfo in fixed mode: ${JSON.stringify(infoB.serverInfo)}`);
  check(Object.keys(infoB.serverProbes ?? {}).length === 0, `fixed mode probed origins: ${JSON.stringify(infoB.serverProbes)}`);
  log(`second Chrome, fixed mode: panel "${lineB.replace(/\s+/g, " ").trim()}", no probes`);

  const boxB = (fn, ...args) => inTranscriptBox(cdpB, pageB, fn, ...args);
  const boxStateB = () => boxB("function () { const box = this.querySelector('.box'); return box && { review: box.classList.contains('review'), text: this.querySelector('textarea').value, error: this.querySelector('.error').textContent }; }");

  // 8a. from the menu
  await clickMenuItem(cdpB, await menuB(), "Voice note");
  await waitFor(async () => (await badgeB()) === "MIC", { what: `the MIC badge. Panel says: ${await toastsB()}` });
  await offscreenB();
  await waitFor(boxStateB, { what: "the transcript box on the page during a voice note" }).catch((e) => check(false, e.message));
  await sleep(2_000);
  const micInUse = await evB("chrome.storage.session.get('recordingVoice').then(s => s.recordingVoice?.microphoneLabel)");
  const voiceMenu = await menuB();
  const voiceItems = await menuItems(cdpB, voiceMenu);
  check(JSON.stringify(voiceItems) === JSON.stringify(["Stop voice note"]), `menu during a voice note: ${JSON.stringify(voiceItems)}`);
  await clickMenuItem(cdpB, voiceMenu, "Stop voice note");
  await waitForEntries(10, `entry 10 (voice note from the menu). Panel says: ${await toastsB()}`);
  await waitFor(async () => !(await boxStateB()), { timeoutMs: 3_000, what: "the untouched transcript box to close" }).catch((e) => check(false, e.message));
  log(`10/14 voice note from the menu (mic "${micInUse}", badge MIC). Panel says: ${(await toastsB()).replace(/\s*×\s*/g, " | ").trim() || "(nothing)"}`);

  // 8b. a microphone that doesn't exist -> default, with a message
  await evB(`chrome.storage.local.set({ microphoneId: "no-such-device", microphoneLabel: "Gone Mic" })`);
  await commandB("toggle-voice");
  await waitFor(async () => (await toastsB()).includes("Selected microphone not found; used the default"), { what: `the microphone fallback message. Panel says: ${await toastsB()}` })
    .catch((e) => check(false, e.message));
  const fallbackTitle = await evB("chrome.action.getTitle({})");
  check(/selected one not found/.test(fallbackTitle), `toolbar tooltip does not mention the microphone fallback: ${fallbackTitle}`);
  await sleep(1_500);
  await commandB("toggle-voice");
  await waitForEntries(11, "entry 11 (voice note with a missing microphone)");
  log("11/14 voice note with a missing microphone fell back to the default and said so");

  // 8c. pick a real (fake) device in Settings
  const picked = await evaluate(cdpB, panelB, `(async () => {
    const select = document.querySelector('.mic-picker select');
    for (let i = 0; i < 50 && ![...select.options].some(o => o.text === 'Fake Audio Input 1'); i++) await new Promise(r => setTimeout(r, 100));
    const option = [...select.options].find(o => o.text === 'Fake Audio Input 1');
    if (!option) return { error: [...select.options].map(o => o.text).join(', ') };
    select.value = option.value;
    select.dispatchEvent(new Event('change'));
    return { options: [...select.options].map(o => o.text) };
  })()`);
  check(!picked.error, `Fake Audio Input 1 not offered by the microphone picker: ${picked.error}`);
  await waitFor(async () => (await evB("chrome.storage.local.get('microphoneLabel').then(s => s.microphoneLabel)")) === "Fake Audio Input 1", { what: "the picked microphone to be saved" })
    .catch((e) => check(false, e.message));
  await commandB("toggle-voice");
  const used = await waitFor(async () => (await evB("chrome.storage.session.get('recordingVoice').then(s => s.recordingVoice?.microphoneLabel ?? null)")), { what: "voice note state" });
  check(used === "Fake Audio Input 1", `voice note used "${used}", expected the picked "Fake Audio Input 1"`);
  await sleep(1_500);
  await commandB("toggle-voice");
  await waitForEntries(12, "entry 12 (voice note with the picked microphone)");
  log(`12/14 voice note with the picked microphone ("${used}"); picker offered: ${picked.options?.join(", ")}`);

  // 8d. edit the transcript in the box, stop: the box stays for review; Save writes the edited text.
  const editedText = "Edited in the transcript box (e2e).";
  // Headless pages aren't focused; without this, focus() in the box fires no focus event.
  await cdpB.send("Emulation.setFocusEmulationEnabled", { enabled: true }, pageB);
  await commandB("toggle-voice");
  await waitFor(boxStateB, { what: "the transcript box for the reviewed voice note" });
  await boxB("function () { this.querySelector('textarea').focus(); }");
  await cdpB.send("Input.insertText", { text: editedText }, pageB);
  await sleep(1_000);
  await commandB("toggle-voice");
  const review = await waitFor(async () => {
    const state = await boxStateB();
    return state?.review ? state : null;
  }, { what: "the transcript box to switch to review after stopping" }).catch((e) => (check(false, e.message), null));
  await sleep(2_500); // longer than the recogniser's final-result grace: nothing may be saved while the user reviews
  check(entryCount(readNotes(outDir)) === 12, "a reviewed voice note was saved before the user clicked Save");
  check(review?.text.includes(editedText), `review box text: ${JSON.stringify(review?.text)}`);
  await boxB("function (label) { [...this.querySelectorAll('button')].find(b => b.textContent === label).click(); }", "Save");
  await waitForEntries(13, `entry 13 (reviewed voice note). Panel says: ${await toastsB()}`);
  await waitFor(async () => !(await boxStateB()), { timeoutMs: 3_000, what: "the transcript box to close after Save" }).catch((e) => check(false, e.message));
  log(`13/14 voice note edited in the box, reviewed and saved (${JSON.stringify(review?.text)})`);

  // 8e. same, but Discard: nothing is written.
  await commandB("toggle-voice");
  await waitFor(boxStateB, { what: "the transcript box for the discarded voice note" });
  await boxB("function () { this.querySelector('textarea').focus(); }");
  await cdpB.send("Input.insertText", { text: "Throw this away." }, pageB);
  await sleep(1_000);
  await commandB("toggle-voice");
  await waitFor(async () => (await boxStateB())?.review, { what: "review before discarding" }).catch((e) => check(false, e.message));
  await boxB("function (label) { [...this.querySelectorAll('button')].find(b => b.textContent === label).click(); }", "Discard…");
  await boxB("function (label) { [...this.querySelectorAll('button')].find(b => b.textContent === label).click(); }", "Discard");
  await waitFor(async () => !(await boxStateB()), { timeoutMs: 3_000, what: "the transcript box to close after Discard" }).catch((e) => check(false, e.message));
  await waitFor(async () => (await toastsB()).includes("Voice note discarded."), { what: "the discard message" }).catch((e) => check(false, e.message));
  await sleep(1_000);
  check(entryCount(readNotes(outDir)) === 13, "a discarded voice note was written");
  log("discarded voice note: box closed, nothing written");

  // 8f. a screenshot note dictated in the prompt. The fake microphone only
  // beeps, and headless speech recognition may refuse or hear nothing, so
  // this checks that the mic button opens the microphone (or says why not)
  // without breaking the prompt, and that Save stops it and keeps the typed text.
  const dictatedNote = "Typed while dictating (e2e).";
  await commandB("screenshot-viewport");
  const promptB = await screenshotPrompt(cdpB, collectorB);
  const micStateB = () => evaluate(cdpB, promptB.session, `({
    shown: !document.getElementById('mic').hidden,
    pressed: document.getElementById('mic').getAttribute('aria-pressed'),
    status: document.getElementById('status').textContent,
  })`);
  const micBefore = await micStateB();
  let micDuring = micBefore;
  if (micBefore.shown) {
    await evaluate(cdpB, promptB.session, "document.getElementById('mic').click()");
    micDuring = await waitFor(async () => {
      const state = await micStateB();
      return state.pressed === "true" || state.status !== micBefore.status ? state : null;
    }, { what: "the prompt's mic button to start dictation (or say why it can't)" }).catch((e) => (check(false, e.message), micBefore));
    check(!/blocked|Could not start/.test(micDuring.status), `dictation with the fake microphone failed to open it: ${micDuring.status}`);
  }
  await sleep(1_000);
  await typeInPrompt(cdpB, promptB.session, dictatedNote);
  await evaluate(cdpB, promptB.session, "document.getElementById('save').click()");
  await waitForEntries(14, `entry 14 (screenshot with a dictated note). Prompt says: ${(await micStateB().catch(() => ({}))).status}`);
  await promptGone(cdpB, promptB.targetId).catch((e) => check(false, e.message));
  log(`14/14 screenshot note in the prompt with dictation (mic shown=${micBefore.shown}, pressed=${micDuring.pressed}, status "${micDuring.status}")`);

  for (const [name, session] of [["worker B", workerB.sessionId], ["side panel B", panelB], ["example page B", pageB], ["note prompt B", promptB.session], ...offscreenSessionsB.map((s) => ["offscreen B", s])]) {
    for (const e of collectorB.get(session)) check(false, `${name}: ${e}`);
  }
  cdpB.close();
  cdpB = null;
  await stopChrome(chromeB);
  chromeB = null;

  check(!(await viteOverlay()), "a Vite error overlay appeared during the test");

  // ---- cross-origin path (preflight / local network access) ----------------------
  const workerFetch = await evaluate(
    cdp,
    worker.sessionId,
    `fetch(${JSON.stringify(origin + "/__holt/status")}, { headers: { "x-holt-client": "extension" } })
       .then(async r => ({ status: r.status, body: await r.json() }), e => ({ error: String(e) }))`,
  );
  check(workerFetch.status === 200 && workerFetch.body?.ok === true, `worker fetch of /status failed: ${JSON.stringify(workerFetch)}`);
  await sleep(300);
  const seen = [...requests.values()];
  // Only requests to the holt server count: the dead fallback URL refuses connections by design.
  const blocked = seen.filter((r) => r.failed && r.url.startsWith(origin));
  const toFallback = seen.filter((r) => r.url.startsWith(deadFallback));
  check(toFallback.every((r) => r.method === "GET" && r.url.endsWith("/__holt/status")), `captures went to the fallback URL: ${JSON.stringify(toFallback)}`);
  const preflights = seen.filter((r) => r.method === "OPTIONS");
  for (const r of blocked) {
    check(false, `request blocked by Chrome: ${r.method} ${r.url}: ${r.failed}${r.blocked ? ` (${r.blocked})` : ""}` +
      (/private|local/i.test(`${r.failed} ${r.blocked}`) ? " <- Private/Local Network Access" : ""));
  }
  const fromWorker = seen.filter((r) => r.from === worker.sessionId && r.method === "POST");
  check(fromWorker.length >= 6 && fromWorker.every((r) => r.status === 200), `worker uploads did not all succeed: ${JSON.stringify(fromWorker)}`);
  log(`network: ${seen.length} requests to /__holt seen (${fromWorker.length} POSTs from the worker, all ${[...new Set(fromWorker.map((r) => r.status))].join("/")}); ` +
    `CORS preflights sent by Chrome: ${preflights.length}; blocked: ${blocked.length}`);

  // The server's own preflight answer for this extension's origin (what Chrome
  // would send if it did preflight, e.g. without host permissions).
  const preflight = await fetch(`${origin}/__holt/media`, {
    method: "OPTIONS",
    headers: {
      origin: `chrome-extension://${worker.extensionId}`,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-holt-client,x-holt-kind",
    },
  });
  const acao = preflight.headers.get("access-control-allow-origin");
  const acah = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  check(preflight.ok && acao === `chrome-extension://${worker.extensionId}`, `server preflight answer: ${preflight.status}, allow-origin=${acao}`);
  check(["x-holt-client", "x-holt-kind", "content-type"].every((h) => acah.includes(h) || acah === "*"), `server preflight allow-headers missing ours: ${acah}`);
  log(`server preflight for chrome-extension origin: ${preflight.status}, allow-origin=${acao}, allow-headers=${acah}`);

  // ---- on disk ----------------------------------------------------------------
  const dirs = sessionDirs(outDir);
  require_(dirs.length === 1, `expected exactly one session folder in ${outDir}, found ${dirs.length}: ${dirs.map((d) => basename(d)).join(", ")}`);
  const sessionDir = dirs[0];
  check(/^\d{4}-\d{2}-\d{2}-\d{6}$/.test(basename(sessionDir)), `unexpected session folder name ${basename(sessionDir)}`);
  const notes = readNotes(outDir);

  check(new RegExp(`^# ${config.sessionTitle} \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\n`).test(notes), "notes.md header line missing or unexpected");
  check(/^- Started: \S+$/m.test(notes), "notes.md header has no 'Started:' line");

  const entries = parseEntries(notes);
  const expected = [
    "Screenshot", "Screenshot (full page)", "Screenshot (area)", "Screenshot", "Screenshot", "Recording", "Note",
    "Screenshot", "Recording", "Voice note", "Voice note", "Voice note", "Voice note", "Screenshot",
  ];
  check(entries.length === expected.length, `expected ${expected.length} entries, found ${entries.length}`);
  expected.forEach((label, i) => {
    const e = entries[i];
    if (!check(e, `entry ${i + 1} missing`)) return;
    check(e.seq === i + 1, `entry ${i + 1} is numbered ${e.seq}`);
    check(e.label === label, `entry ${i + 1} heading is "${e.label}", expected "${label}"`);
    check(e.pageUrl?.startsWith(pageUrl), `entry ${i + 1} Page link is ${e.pageUrl ?? "missing"}, expected ${pageUrl}`);
  });
  // One entry per capture: the user's words are a blockquote under the media; a plain note is the body.
  const quoted = (i, text) => entries[i]?.block.includes(`\n> ${text}\n`);
  check(quoted(0, shotNote), `the typed note is not quoted under screenshot 1: ${entries[0]?.block}`);
  for (const i of [1, 2, 3, 7]) check(!/^>/m.test(entries[i]?.block ?? ""), `screenshot ${i + 1} should have no note: ${entries[i]?.block}`);
  check(quoted(4, savedNote), `the note saved with the button is not under screenshot 5: ${entries[4]?.block}`);
  check(entries[6]?.block.includes(`\n${popupNote}\n`) && !quoted(6, popupNote), `popup note is not the body of entry 7: ${entries[6]?.block}`);
  check(quoted(12, editedText), `the reviewed words are not the note of entry 13: ${entries[12]?.block}`);
  check(!/Transcript:/.test(notes), "notes.md still has a \"Transcript:\" prefix");
  check(entries[13]?.block.includes(dictatedNote), `the typed text is not in the dictated screenshot note (entry 14): ${entries[13]?.block}`);
  // A voice note with words keeps no audio by default; one with no words keeps it so it isn't empty.
  check(/^🎙 \(\d+:\d\d\)$/m.test(entries[12]?.block ?? "") && !/\.webm/.test(entries[12]?.block ?? ""), `entry 13 should have no audio (keepAudio is off by default): ${entries[12]?.block}`);
  // Recordings and voice notes with audio: the linked file exists and is WebM (EBML magic 1A 45 DF A3).
  for (const [i, e] of entries.entries()) {
    if (!e || !["Recording", "Voice note"].includes(e.label)) continue;
    const link = e.block.match(/\]\(\.\/([^)]+\.webm)\)/)?.[1];
    // Only a voice note with a note may come without audio (checked above).
    if (e.label === "Voice note" && !link && /^> /m.test(e.block)) continue;
    if (!check(link, `entry ${i + 1} (${e.label}) has no .webm link`)) continue;
    const bytes = readFileSync(join(sessionDir, link));
    check(bytes.length > 1000 && bytes.readUInt32BE(0) === 0x1a45dfa3, `${link} is not a WebM file (${bytes.length} bytes)`);
    log(`${e.label} #${i + 1}: ${link} ${bytes.length} bytes`);
  }

  const pngs = {};
  for (const [i, e] of entries.slice(0, 3).entries()) {
    if (!check(e.image, `entry ${i + 1} has no image link`)) continue;
    const file = join(sessionDir, e.image);
    if (!check(existsSync(file), `missing file ${e.image}`)) continue;
    const info = pngInfo(file);
    check(info.ok, `${e.image} is not a valid PNG: ${info.reason}`);
    pngs[expected[i]] = { file: e.image, ...info };
  }
  const vp = pngs["Screenshot"];
  const fp = pngs["Screenshot (full page)"];
  const area = pngs["Screenshot (area)"];
  if (vp && fp) check(fp.height > vp.height, `full-page PNG (${fp.height}px) is not taller than the viewport PNG (${vp.height}px)`);
  // Each capture is as wide as the page viewport at that moment (CSS px * DPR).
  for (const label of ["Screenshot", "Screenshot (full page)"]) {
    const p = pngs[label];
    const v = viewports[label];
    if (p && v) check(p.width === Math.round(v.w * v.dpr), `${label} PNG is ${p.width}px wide, page viewport was ${v.w} CSS px at DPR ${v.dpr}`);
  }
  if (vp) {
    const v = viewports["Screenshot"];
    check(vp.height === Math.round(v.h * v.dpr), `viewport PNG is ${vp.height}px tall, page viewport was ${v.h} CSS px`);
  }
  // The fixed header must appear exactly once: present at the top of tile 1,
  // absent at the same viewport position in every later full tile.
  if (fp) {
    const image = decodePng(readFileSync(join(sessionDir, fp.file)));
    const { h: vh, dpr } = viewports["Screenshot (full page)"];
    const accent = parseCssColor(headerProbe.color);
    const at = (cssY) => image.pixel(headerProbe.x * dpr, cssY * dpr);
    const top = at(headerProbe.y);
    check(colorClose(top, accent), `fixed header not found at the top of the full-page PNG (pixel ${top}, expected ~${accent})`);
    const pageH = image.height / dpr;
    const repeats = [];
    let tilesChecked = 0;
    // Tile i starts at i*vh. Only tiles the browser could scroll to exactly
    // (i*vh <= pageH - vh) show the viewport's top edge, where the header sits.
    for (let i = 1; i * vh <= pageH - vh; i++) {
      tilesChecked++;
      const px = at(i * vh + headerProbe.y);
      if (colorClose(px, accent)) repeats.push(`tile ${i + 1} at y=${i * vh + headerProbe.y}`);
    }
    check(tilesChecked > 0, `full-page PNG too short (${pageH} CSS px for a ${vh} px viewport) to test header repetition`);
    check(repeats.length === 0, `fixed header repeated in the full-page PNG: ${repeats.join(", ")}`);
    log(`fixed header: present at top (pixel ${top}), absent in ${tilesChecked - repeats.length}/${tilesChecked} later tiles`);
  }
  if (area) {
    const { dpr } = viewports["Screenshot (area)"];
    const want = { w: Math.round(200 * dpr), h: Math.round(150 * dpr) };
    check(Math.abs(area.width - want.w) <= 1 && Math.abs(area.height - want.h) <= 1, `area PNG is ${area.width}x${area.height}, expected ~${want.w}x${want.h}`);
  }
  for (const [label, p] of Object.entries(pngs)) {
    const v = viewports[label];
    log(`${label}: ${p.file} ${p.width}x${p.height} (${p.bytes} bytes); page viewport before capture ${v?.w}x${v?.h} @${v?.dpr}x`);
  }

  // ---- console errors in the extension -------------------------------------------
  for (const [name, session] of [["worker", worker.sessionId], ["side panel", panel], ["example page", page], ["note popup", note], ...menuSessions.map((x) => ["menu", x]), ...promptSessions.map((x) => ["note prompt", x]), ...offscreenSessions.map((x) => ["offscreen", x])]) {
    for (const e of collector.get(session)) check(false, `${name}: ${e}`);
  }

  // ---- stop Vite: the plugin must end the session -----------------------------------
  const exit = await stopVite(vite, "SIGTERM");
  check(exit, "Vite did not exit within 10 s of SIGTERM");
  notesAtEnd = readNotes(outDir);
  const lastLine = notesAtEnd.trimEnd().split("\n").at(-1);
  check(/^_Session ended at \S+ \(14 entries\)\._$/.test(lastLine), `notes.md does not end with the session footer; last line: ${JSON.stringify(lastLine)}`);
  log(`Vite exited (${exit ? `code ${exit.code}, signal ${exit.sig}` : "killed"}); last line: ${lastLine}`);
} catch (error) {
  failures.push(error instanceof Fatal ? error.message : `${error.stack ?? error}`);
  if (vite) console.error(`[e2e] Vite output:\n${vite.output()}`);
} finally {
  const notes = notesAtEnd || readNotes(outDir);
  if (notes) console.log(`\n----- notes.md -----\n${notes}----- end notes.md -----\n`);
  await cleanup();
}

if (failures.length) {
  console.error(`[e2e] FAIL (${failures.length})\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
log("PASS");
process.exit(0);
