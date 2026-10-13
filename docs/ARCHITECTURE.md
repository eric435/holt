# nitpick architecture

nitpick lets you take screenshots, record your screen, and dictate or type
notes while clicking through your own app, and writes all of it into a single
markdown file (plus media files) inside your repo. It has two halves that talk
over localhost HTTP:

```
┌──────────────────────────────┐          ┌───────────────────────────────┐
│  Chrome extension (MV3)      │  HTTP    │  nitpick server (Node)        │
│                              │ ───────▶ │                               │
│  side panel  = the UI        │ JSON +   │  core request handler         │
│  service worker = coordinator│ raw bytes│  session + markdown writer    │
│  content script = page helper│          │  config loader                │
│                              │          │  ├─ CLI adapter (npx nitpick) │
│                              │          │  └─ Vite plugin adapter       │
└──────────────────────────────┘          └───────────────────────────────┘
                                                        │
                                                        ▼
                                          qa/2026-10-13-075200/notes.md
                                          qa/2026-10-13-075200/001-screenshot.png
                                          qa/2026-10-13-075200/002-recording.webm
```

The wire format between the halves is defined once, in
[`packages/shared`](../packages/shared/src/index.ts) (`@nitpick/protocol`).
Both sides import those types, so a protocol change that is not applied on
both sides fails to compile.

## Repository layout

```
packages/
  shared/      @nitpick/protocol  types + constants, zero runtime code
  server/      nitpick-notes      the published npm package (CLI, Vite plugin, core)
  extension/   @nitpick/extension the Chrome extension (built with esbuild, loaded unpacked)
examples/
  vite-app/    a tiny app to try nitpick against
docs/
  ARCHITECTURE.md  this file
  SECURITY.md      threat model and the rules the code follows
```

pnpm workspaces link the packages together. `@nitpick/protocol` has no build
step: the other packages import its TypeScript source directly and their own
bundlers (tsup for the server, esbuild for the extension) compile it in.

## The server package (`packages/server`, published as `nitpick-notes`)

Layered so each piece is testable on its own and the HTTP surface is
framework-agnostic:

```
src/
  config/        load + validate nitpick.config.json; defaults; JSON schema
  session/       SessionStore: the one active session; folder + file naming;
                 MarkdownWriter: appends entries to notes.md
  http/          createHandler(): a plain (req, res) => Promise<boolean> that
                 implements the protocol; CORS/origin/token checks; body limits
  adapters/
    standalone/  createServer(): node:http server on DEFAULT_PORT (used by the CLI)
    vite/        nitpick/vite: Vite plugin that mounts the handler on the dev server
  cli/           `nitpick` bin: parses args, loads config, starts standalone server
  index.ts       public API: createNitpick(), types
```

Key decisions:

- **Zero runtime dependencies.** The package is installed as a dev dependency
  in other people's projects; every dependency we add is attack surface in
  their supply chain. Node's `http`, `fs`, `path`, `crypto` cover everything.
  Vite is an optional peer dependency used only by the Vite adapter.
- **The handler is mounted under `/__nitpick` everywhere.** Standalone and
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

Manifest V3. Three execution contexts, each with one job:

```
src/
  background/     service worker. Owns nothing long-lived (MV3 workers are
                  killed when idle); state lives in chrome.storage.session.
                  Handles keyboard commands, takes screenshots
                  (chrome.tabs.captureVisibleTab) and stitches full-page
                  captures.
  sidepanel/      the UI. Buttons for every action, status of the server and
                  session, typed notes, and the media recorders (screen via
                  getDisplayMedia, voice via getUserMedia + MediaRecorder,
                  transcript via the Web Speech API). Recorders live here
                  because MediaRecorder needs a document and a user gesture.
  content/        injected on demand with chrome.scripting.executeScript
                  (never declared in the manifest): the area-select overlay
                  and the scroll helper for full-page capture. Runs in the
                  page's world, so it is kept tiny and sends results back to
                  the service worker and exits.
  shared/         typed message bus between the three contexts, settings
                  (server URL, token), and the server API client. The client
                  is shared because Blobs cannot be passed between extension
                  contexts cheaply: the worker uploads screenshots it took,
                  the side panel uploads recordings it made.
```

Permissions are the minimum: `activeTab` (granted by a hotkey or clicking the
icon, scoped to that tab, no host permissions), `sidePanel`, `scripting`,
`storage`, `commands`. Network access to the local server uses
`host_permissions` for `http://127.0.0.1/*` and `http://localhost/*` only.

Message flow for a full-page screenshot, as an example:

1. User presses the hotkey → `chrome.commands.onCommand` in the worker.
2. Worker injects the content helper into the active tab, asks for page
   dimensions, then loops: scroll to Y → wait a frame → `captureVisibleTab`.
3. Worker stitches the viewport PNGs with `OffscreenCanvas`.
4. Worker `POST /media` (bytes) → gets `file`; `POST /entries` with the
   ScreenshotEntry referencing `file`.
5. Worker broadcasts "entry added" → side panel updates its list.

## Why a side panel instead of in-page buttons

Buttons injected into the page would need a content script on every site
(broad host permissions), fight with the page's CSS, and reload on every
navigation. The side panel is an extension page: it persists across
navigations in that window, has its own origin (so microphone permission is
asked once, for the extension), and can call `getDisplayMedia` from a click.

## Configuration

`nitpick.config.json` in the project root (all keys optional):

```json
{
  "$schema": "./node_modules/nitpick-notes/schema.json",
  "outputDir": "qa",
  "port": 4848,
  "host": "127.0.0.1",
  "token": null,
  "maxUploadBytes": 209715200,
  "sessionTitle": "QA session"
}
```

The config loader validates every key by hand (no schema library at runtime)
and prints a clear message naming the bad key. The JSON schema file is shipped
only for editor autocomplete.
