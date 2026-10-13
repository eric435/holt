# holt architecture

holt lets you take screenshots, record your screen, and dictate or type
notes while clicking through your own app, and writes all of it into a single
markdown file (plus media files) inside your repo. It has two halves that talk
over localhost HTTP:

```
┌──────────────────────────────┐          ┌───────────────────────────────┐
│  Chrome extension (MV3)      │  HTTP    │  holt server (Node)           │
│                              │ ───────▶ │                               │
│  side panel  = the UI        │ JSON +   │  core request handler         │
│  service worker = coordinator│ raw bytes│  session + markdown writer    │
│  content script = page helper│          │  config loader                │
│                              │          │  ├─ CLI adapter (npx holt)    │
│                              │          │  └─ Vite plugin adapter       │
└──────────────────────────────┘          └───────────────────────────────┘
                                                        │
                                                        ▼
                                          qa/2026-10-13-075200/notes.md
                                          qa/2026-10-13-075200/001-screenshot.png
                                          qa/2026-10-13-075200/002-recording.webm
```

The wire format between the halves is defined once, in
[`packages/shared`](../packages/shared/src/index.ts) (`@holt/protocol`).
Both sides import those types, so a protocol change that is not applied on
both sides fails to compile.

## Repository layout

```
packages/
  shared/      @holt/protocol   types + constants, zero runtime code
  server/      holt             the published npm package (CLI, Vite plugin, core)
  extension/   @holt/extension  the Chrome extension (built with esbuild, loaded unpacked)
examples/
  vite-app/    a tiny app to try holt against
docs/
  ARCHITECTURE.md  this file
  SECURITY.md      threat model and the rules the code follows
```

pnpm workspaces link the packages together. `@holt/protocol` has no build
step: the other packages import its TypeScript source directly and their own
bundlers (tsup for the server, esbuild for the extension) compile it in.

## The server package (`packages/server`, published as `holt`)

Layered so each piece is testable on its own and the HTTP surface is
framework-agnostic:

```
src/
  config/        load + validate holt.config.json; defaults; JSON schema
  session/       SessionStore: the one active session; folder + file naming;
                 MarkdownWriter: appends entries to notes.md
  http/          createHandler(): a plain (req, res) => Promise<boolean> that
                 implements the protocol; CORS/origin/token checks; body limits
  adapters/
    standalone/  createServer(): node:http server on DEFAULT_PORT (used by the CLI)
    vite/        holt/vite: Vite plugin that mounts the handler on the dev server
  cli/           `holt` bin: parses args, loads config, starts standalone server
  index.ts       public API: createHolt(), types
```

Key decisions:

- **Zero runtime dependencies.** The package is installed as a dev dependency
  in other people's projects; every dependency we add is attack surface in
  their supply chain. Node's `http`, `fs`, `path`, `crypto` cover everything.
  Vite is an optional peer dependency used only by the Vite adapter.
- **The handler is mounted under `/__holt` everywhere.** Standalone and
  Vite-plugin modes expose identical URLs, so the extension only needs to
  know an origin.
- **The server owns all file names.** The extension never sends a path. Media
  uploads return the file name the server chose (`003-screenshot.png`); the
  entry then references that name, and the server checks it exists in the
  current session before writing a link into the markdown.
- **One active session.** Starting a new one closes the previous one (writes
  an end timestamp). The server also closes the session on SIGINT/SIGTERM and
  when Vite's dev server closes. Uploads with no active session auto-start
  one, so "take a screenshot" is always a single action.
- **Session folder naming**: `<outputDir>/<YYYY-MM-DD-HHMMSS>/`, local time.
  Files inside are `<seq>-<kind>.<ext>`, zero-padded to 3 digits.
- **`GET /status` says which project it serves.** Besides the tool name and
  server version, it returns `project: { name, source }`, so the side panel
  can show "acme-web at http://127.0.0.1:4848" and you can tell two running
  servers apart. The name is resolved once at startup
  (`config/project.ts`): the `projectName` config option, else the `name`
  in `<root>/package.json`, else the root directory's name. Parent
  directories are never searched, so `examples/vite-app` in a monorepo is
  named after itself, not the workspace. A missing, oversized (> 1 MiB) or
  broken package.json just falls through to the directory name; it never
  stops startup. Names are stripped of control and bidi characters and
  capped at 100 characters. The startup banners print the same name.

### Markdown format

```markdown
# QA session 2026-10-13 07:52

- Started: 2026-10-13T07:52:00-07:00
- Project: /Users/you/app

---

## 1. Screenshot · 07:53:12
Page: [Checkout – My App](http://localhost:5173/checkout)

![Screenshot 1](./001-screenshot.png)

> Submit button overlaps the footer on narrow widths.

## 2. Note · 07:54:01
Page: [Checkout – My App](http://localhost:5173/checkout)

Coupon field accepts whitespace-only input.

## 3. Voice note · 07:55:40
Page: [Cart – My App](http://localhost:5173/cart)

🎙 [audio](./003-voice-note.webm) (0:12)

> Transcript: the quantity stepper jumps by two when I click fast.
```

Rendering is done by the server, never the extension, so the extension stays
a thin capture client and the format can evolve in one place.

## The Chrome extension (`packages/extension`)

Manifest V3. Four kinds of execution context, each with one job:

```
src/
  background/     service worker. Owns nothing long-lived (MV3 workers are
                  killed when idle); state lives in chrome.storage.session.
                  Handles keyboard commands, takes screenshots
                  (chrome.tabs.captureVisibleTab), stitches full-page
                  captures, starts/stops the recorders, owns the offscreen
                  document's lifecycle and the toolbar indicator.
  offscreen/      the offscreen document: a hidden page the worker creates
                  (chrome.offscreen, reason USER_MEDIA) while something is
                  recording. Hosts the tab recorder (chrome.tabCapture stream
                  + MediaRecorder) and the voice recorder (getUserMedia +
                  MediaRecorder + Web Speech transcript), and uploads what
                  they record. Survives the side panel being closed.
  sidepanel/      the UI, optional since every action has a shortcut.
                  Buttons, server/session status, typed notes, settings
                  (incl. microphone), and the one panel-bound recorder:
                  "Record a window or screen…" (getDisplayMedia needs a click
                  in a visible document).
  note/           note.html, the Alt+T quick-note popup.
  content/        injected on demand with chrome.scripting.executeScript
                  (never declared in the manifest): the area-select overlay
                  and the scroll helper for full-page capture. Runs in the
                  page's world, so it is kept tiny and sends results back to
                  the service worker and exits.
  shared/         typed message bus between the contexts, settings, the
                  chrome.storage.session wrapper, MediaRecorder helpers, and
                  the server API client. The client is shared because Blobs
                  cannot be passed between extension contexts cheaply:
                  whoever records something uploads it.
  permissions/    a plain extension page opened in a tab when the microphone
                  is needed: the offscreen document can never show a
                  permission prompt (it is invisible), a tab can.
```

Three MV3 details that shaped the code and are worth knowing:

- **The worker can die at any time.** Chrome kills an idle service worker
  after about 30 seconds, and module-level variables vanish with it. An
  area selection (user is still dragging) therefore stores "what I was
  doing" in `chrome.storage.session` and finishes in whatever worker
  instance receives the content script's reply. Recordings work the same
  way: `recordingScreen` / `recordingVoice` in storage.session say what is
  running, and the offscreen document's messages wake a new worker.
- **User gestures are consumed synchronously.** `chrome.sidePanel.open()`
  must be called before the first `await` in a command or click handler.
  And the declarative `openPanelOnActionClick` flag is deliberately *off*:
  with it on, clicking the toolbar icon opens the panel but does not grant
  `activeTab`, so captures from the panel would fail. Handling the click in
  `chrome.action.onClicked` gives both. (`tabCapture.getMediaStreamId` and
  `captureVisibleTab` only need the activeTab grant, which outlives the
  gesture; `action.openPopup` is called synchronously anyway.)
- **Offscreen documents only get `chrome.runtime`.** No storage, no action,
  no tabs. So the worker sends the recorder everything it needs (server
  URL, token, microphone, page context) with each start request, and the
  recorder reports state changes, saved entries and errors back by message;
  the worker updates storage.session, the indicator and the toasts.

### Headless mode: recording from a shortcut

```
 Alt+R ──▶ worker: getMediaStreamId({ targetTabId }) ──┐
                   write recordingScreen (storage.session)
                   ensure offscreen doc (one per extension)
                   "offscreen:start-tab" { streamId, page, settings } ──▶ offscreen:
                                                          getUserMedia(chromeMediaSource: "tab")
                                                          AudioContext: play tab audio back
                                                          MediaRecorder …
 Alt+R ──▶ worker: "offscreen:stop" ─────────────────────────▶ stop, "recorder:stopped" ──▶ worker clears state
                                                          POST /media, POST /entries
                                                          "entry-created" ──▶ worker: recent list,
                                                                              panel toast or badge ✓
                                                          "recorder:idle" ──▶ worker closes the doc
```

The side panel's "Record tab" and "Voice note" buttons send `recorder:toggle`
to the worker and take exactly this path. The toolbar icon is the status
indicator: "REC"/"MIC" badge, a red dot drawn on the icon, and a tooltip
like "holt (acme-web): recording tab since 14:02 (⌥R to stop)". It is
browser UI, so it never appears in screenshots or tab recordings.

Permissions are the minimum: `activeTab` (granted by a hotkey or clicking the
icon, scoped to that tab, no host permissions), `sidePanel`, `scripting`,
`storage`, `offscreen` (the recorders' hidden page) and `tabCapture`
("Record tab": no picker, follows the tab across navigations, and only
usable on a tab where the user invoked holt). Keyboard shortcuts come
from the `commands` manifest key, which is not a permission. Network access
to the local server uses `host_permissions` for `http://127.0.0.1/*` and
`http://localhost/*` only.

Message flow for a full-page screenshot, as an example:

1. User presses the hotkey → `chrome.commands.onCommand` in the worker.
2. Worker injects the content helper into the active tab, asks for page
   dimensions, then loops: scroll to Y → wait a frame → `captureVisibleTab`.
3. Worker stitches the viewport PNGs with `OffscreenCanvas`.
4. Worker `POST /media` (bytes) → gets `file`; `POST /entries` with the
   ScreenshotEntry referencing `file`.
5. Worker broadcasts "entry added" → side panel updates its list (or, with
   the panel closed, the toolbar badge flashes "✓").

## Why a side panel instead of in-page buttons

Buttons injected into the page would need a content script on every site
(broad host permissions), fight with the page's CSS, reload on every
navigation, and show up in screenshots and tab recordings. The side panel is
an extension page: it persists across navigations in that window, has its
own origin (so microphone permission is asked once, for the extension), and
can call `getDisplayMedia` from a click. For the same reasons the
"recording" indicator is the toolbar icon, not an in-page overlay.

## Configuration

`holt.config.json` in the project root (all keys optional):

```json
{
  "$schema": "./node_modules/holt/schema.json",
  "outputDir": "qa",
  "port": 4848,
  "host": "127.0.0.1",
  "token": null,
  "maxUploadBytes": 209715200,
  "sessionTitle": "QA session",
  "projectName": "acme-web"
}
```

(`projectName` has no fixed default: when it is unset the server uses the
package.json name or the directory name, as described above.)

The config loader validates every key by hand (no schema library at runtime)
and prints a clear message naming the bad key. The JSON schema file is shipped
only for editor autocomplete.
