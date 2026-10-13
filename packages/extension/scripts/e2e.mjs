#!/usr/bin/env node
/**
 * End-to-end test: the real extension in headless Chrome against the real
 * nitpick server, mounted in the example Vite app, checked on disk.
 *
 *   1. Build the server (if packages/server/dist is missing) and the extension.
 *   2. Start examples/vite-app with the Vite CLI on a free port
 *      (--port N --strictPort). It runs from a temp copy whose
 *      nitpick.config.json points outputDir at a temp folder, so nothing is
 *      written into examples/vite-app. `node_modules` in the copy only
 *      contains symlinks to `vite` and `nitpick-notes`.
 *   3. Load the extension, point its serverUrl at the Vite origin, open the
 *      example page, and click the toolbar icon (Extensions.triggerAction).
 *      That opens the real side panel and grants activeTab.
 *   4. In the side panel: Visible, Full page, Area (dragging with synthetic
 *      mouse events in the page), then a typed note (Ctrl+Enter).
 *      Screenshots go panel -> worker -> server; the note goes panel -> server.
 *   5. Check on disk: one session folder; notes.md has a header and entries
 *      1-4 with the right headings and Page links; the PNGs are valid and
 *      the full-page one is taller than the viewport one. Then SIGTERM Vite
 *      and check the "_Session ended at" footer.
 *   6. Check the cross-origin path: the worker's requests succeed (Chrome's
 *      local/private network checks don't block them), whether Chrome sent a
 *      CORS preflight, and that the server answers a preflight for this
 *      extension's origin.
 *
 * Only processes this script started (by PID) are stopped. Temp dirs are
 * removed even on failure (set KEEP_TEMP=1 to keep them).
 *
 * Usage: pnpm --filter @nitpick/extension e2e
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  if (!existsSync(join(SERVER_PKG, "dist/vite.js"))) run("pnpm", ["--filter", "nitpick-notes", "build"], "building the server");
  run("pnpm", ["--filter", "@nitpick/extension", "build"], "building the extension");
}

// ---------------------------------------------------------------------------
// Vite (the example app with the nitpick plugin)
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

/** Copy the example app into `appDir`, redirecting nitpick's outputDir to `outDir`. */
function prepareApp(appDir, outDir) {
  cpSync(EXAMPLE, appDir, {
    recursive: true,
    filter: (src) => !["node_modules", "qa", "dist"].includes(basename(src)) || src === EXAMPLE,
  });
  const config = JSON.parse(readFileSync(join(EXAMPLE, "nitpick.config.json"), "utf8"));
  config.outputDir = outDir; // absolute: the server resolves it against the root, which keeps it as is
  delete config.$schema; // points into node_modules; not needed here
  writeFileSync(join(appDir, "nitpick.config.json"), JSON.stringify(config, null, 2));
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
  for (const name of ["vite", "nitpick-notes"]) {
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
  const buf = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(signature)) return { ok: false, reason: "bad PNG signature" };
  if (buf.toString("ascii", 12, 16) !== "IHDR") return { ok: false, reason: "first chunk is not IHDR" };
  return { ok: true, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
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

const temp = mkdtempSync(join(tmpdir(), "nitpick-e2e-"));
const appDir = join(temp, "app");
const outDir = join(temp, "out");
let vite;
let chrome;
let cdp;
let notesAtEnd = "";

async function cleanup() {
  cdp?.close();
  await stopChrome(chrome).catch(() => undefined);
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
  log(`Vite + nitpick plugin at ${origin}, writing to ${outDir}`);

  // ---- browser ----------------------------------------------------------------
  // A desktop-sized window: the side panel takes ~1/3 of it once open.
  chrome = await launchChrome({ headless: true, extensionDir: DIST, extraArgs: ["--window-size=1280,900"] });
  cdp = await Cdp.connect(chrome.wsUrl);
  const collector = errorCollector(cdp);
  const worker = await loadExtension(cdp, DIST, collector, { log });
  require_(worker, "the extension's service worker never started (headless Chrome)");
  log(`extension ${worker.extensionId} loaded (${worker.method})`);

  // Watch the network from the worker and (later) the panel: which requests
  // were made to /__nitpick, any CORS preflight, any blocked request.
  const requests = new Map(); // requestId -> { method, url, status, failed, blocked, from }
  cdp.on((msg) => {
    const p = msg.params;
    if (msg.method === "Network.requestWillBeSent" && p.request.url.includes("/__nitpick")) {
      requests.set(p.requestId, { method: p.request.method, url: p.request.url, from: msg.sessionId });
    } else if (msg.method === "Network.responseReceived" && requests.has(p.requestId)) {
      requests.get(p.requestId).status = p.response.status;
    } else if (msg.method === "Network.loadingFailed" && requests.has(p.requestId)) {
      Object.assign(requests.get(p.requestId), { failed: p.errorText, blocked: p.blockedReason ?? p.corsErrorStatus?.corsError });
    }
  });
  await cdp.send("Network.enable", {}, worker.sessionId);

  await evaluate(cdp, worker.sessionId, `chrome.storage.sync.set({ serverUrl: ${JSON.stringify(origin)} })`);

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

  // Toolbar click: opens the real side panel and grants activeTab.
  await clickToolbarIcon(cdp, worker.extensionId, pageUrl);
  const panelUrl = `chrome-extension://${worker.extensionId}/sidepanel.html`;
  const panelTarget = await waitFor(
    async () => (await cdp.send("Target.getTargets")).targetInfos.find((t) => t.url === panelUrl),
    { what: "the side panel to open after the toolbar click" },
  );
  const panel = await attach(cdp, panelTarget.targetId);
  await collector.watch(panel);
  await cdp.send("Network.enable", {}, panel);
  const serverLine = await waitFor(
    async () => {
      const text = await evaluate(cdp, panel, "document.querySelector('.server-line')?.innerText ?? ''");
      return /nitpick .* at /.test(text) ? text : null;
    },
    { timeoutMs: 15_000, what: "the side panel to report the server as reachable" },
  );
  log(`side panel connected: "${serverLine.trim()}"`);

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

  const clickPanelButton = (label) =>
    evaluate(cdp, panel, `(() => {
      const b = [...document.querySelectorAll('#actions button')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
      if (!b) throw new Error('no button ' + ${JSON.stringify(label)});
      b.click();
    })()`);
  const waitForEntries = (n, what) =>
    waitFor(() => entryCount(readNotes(outDir)) >= n, { timeoutMs: 30_000, intervalMs: 200, what });
  const panelToasts = () => evaluate(cdp, panel, "document.getElementById('toasts').innerText").catch(() => "");

  /** Page viewport (CSS px) and DPR right before each capture: PNG sizes must match. */
  const viewports = {};
  const pageViewport = () => evaluate(cdp, page, "({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })");

  // ---- 1. viewport screenshot -------------------------------------------------
  viewports["Screenshot"] = await pageViewport();
  await clickPanelButton("Visible");
  await waitForEntries(1, `entry 1 (viewport screenshot). Panel says: ${await panelToasts()}`);
  log("1/4 viewport screenshot written");

  // ---- 2. full-page screenshot ------------------------------------------------
  viewports["Screenshot (full page)"] = await pageViewport();
  await clickPanelButton("Full page");
  await waitForEntries(2, "entry 2 (full-page screenshot)");
  const scrollAfter = await evaluate(cdp, page, "scrollY");
  check(scrollAfter === 0, `full-page capture did not restore the scroll position (scrollY=${scrollAfter})`);
  log("2/4 full-page screenshot written");

  // ---- 3. area screenshot: real overlay, synthetic drag ------------------------
  viewports["Screenshot (area)"] = await pageViewport();
  await clickPanelButton("Area");
  await waitFor(() => evaluate(cdp, page, "!!document.querySelector('nitpick-area-select')"), { what: "the area-select overlay" });
  // 200 x 150 CSS px, kept inside the viewport (the overlay clamps to it).
  const viewportWidth = await evaluate(cdp, page, "innerWidth");
  require_(viewportWidth >= 260, `page viewport is only ${viewportWidth}px wide`);
  const drag = { x0: 40, y0: 120, x1: 240, y1: 270 };
  const mouse = (type, x, y) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }, page);
  await mouse("mousePressed", drag.x0, drag.y0);
  for (let i = 1; i <= 5; i++) await mouse("mouseMoved", drag.x0 + ((drag.x1 - drag.x0) * i) / 5, drag.y0 + ((drag.y1 - drag.y0) * i) / 5);
  await mouse("mouseReleased", drag.x1, drag.y1);
  await waitForEntries(3, "entry 3 (area screenshot)");
  log("3/4 area screenshot written");

  // ---- 4. typed note via the panel's API client ---------------------------------
  const noteText = "Coupon field accepts whitespace-only input (e2e).";
  await evaluate(cdp, panel, `(() => {
    const t = document.querySelector('#notes textarea');
    t.value = ${JSON.stringify(noteText)};
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  })()`);
  await waitForEntries(4, "entry 4 (note)");
  log("4/4 note written");

  check(!(await viteOverlay()), "a Vite error overlay appeared during the test");

  // ---- cross-origin path (preflight / local network access) ----------------------
  const workerFetch = await evaluate(
    cdp,
    worker.sessionId,
    `fetch(${JSON.stringify(origin + "/__nitpick/status")}, { headers: { "x-nitpick-client": "extension" } })
       .then(async r => ({ status: r.status, body: await r.json() }), e => ({ error: String(e) }))`,
  );
  check(workerFetch.status === 200 && workerFetch.body?.ok === true, `worker fetch of /status failed: ${JSON.stringify(workerFetch)}`);
  await sleep(300);
  const seen = [...requests.values()];
  const blocked = seen.filter((r) => r.failed);
  const preflights = seen.filter((r) => r.method === "OPTIONS");
  for (const r of blocked) {
    check(false, `request blocked by Chrome: ${r.method} ${r.url}: ${r.failed}${r.blocked ? ` (${r.blocked})` : ""}` +
      (/private|local/i.test(`${r.failed} ${r.blocked}`) ? " <- Private/Local Network Access" : ""));
  }
  const fromWorker = seen.filter((r) => r.from === worker.sessionId && r.method === "POST");
  check(fromWorker.length >= 6 && fromWorker.every((r) => r.status === 200), `worker uploads did not all succeed: ${JSON.stringify(fromWorker)}`);
  log(`network: ${seen.length} requests to /__nitpick seen (${fromWorker.length} POSTs from the worker, all ${[...new Set(fromWorker.map((r) => r.status))].join("/")}); ` +
    `CORS preflights sent by Chrome: ${preflights.length}; blocked: ${blocked.length}`);

  // The server's own preflight answer for this extension's origin (what Chrome
  // would send if it did preflight, e.g. without host permissions).
  const preflight = await fetch(`${origin}/__nitpick/media`, {
    method: "OPTIONS",
    headers: {
      origin: `chrome-extension://${worker.extensionId}`,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-nitpick-client,x-nitpick-kind",
    },
  });
  const acao = preflight.headers.get("access-control-allow-origin");
  const acah = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  check(preflight.ok && acao === `chrome-extension://${worker.extensionId}`, `server preflight answer: ${preflight.status}, allow-origin=${acao}`);
  check(["x-nitpick-client", "x-nitpick-kind", "content-type"].every((h) => acah.includes(h) || acah === "*"), `server preflight allow-headers missing ours: ${acah}`);
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
  const expected = ["Screenshot", "Screenshot (full page)", "Screenshot (area)", "Note"];
  check(entries.length === 4, `expected 4 entries, found ${entries.length}`);
  expected.forEach((label, i) => {
    const e = entries[i];
    if (!check(e, `entry ${i + 1} missing`)) return;
    check(e.seq === i + 1, `entry ${i + 1} is numbered ${e.seq}`);
    check(e.label === label, `entry ${i + 1} heading is "${e.label}", expected "${label}"`);
    check(e.pageUrl?.startsWith(pageUrl), `entry ${i + 1} Page link is ${e.pageUrl ?? "missing"}, expected ${pageUrl}`);
  });
  check(entries[3]?.block.includes(noteText), "note text not found in entry 4");

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
  for (const [name, session] of [["worker", worker.sessionId], ["side panel", panel], ["example page", page]]) {
    for (const e of collector.get(session)) check(false, `${name}: ${e}`);
  }

  // ---- stop Vite: the plugin must end the session -----------------------------------
  const exit = await stopVite(vite, "SIGTERM");
  check(exit, "Vite did not exit within 10 s of SIGTERM");
  notesAtEnd = readNotes(outDir);
  const lastLine = notesAtEnd.trimEnd().split("\n").at(-1);
  check(/^_Session ended at \S+ \(4 entries\)\._$/.test(lastLine), `notes.md does not end with the session footer; last line: ${JSON.stringify(lastLine)}`);
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
