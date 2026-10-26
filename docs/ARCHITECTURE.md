# holt architecture

holt lets you take screenshots, record your screen, and dictate or type
notes while clicking through your own app, and writes all of it into a single
markdown file (plus media files) inside your repo. It has two halves that talk
over localhost HTTP:

```
┌──────────────────────────────┐          ┌───────────────────────────────┐
│  Chrome extension (MV3)      │  HTTP    │  holt server (Node)           │
│                              │ ───────▶ │                               │
│  toolbar menu + side panel   │ JSON +   │  core request handler         │
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
  shared/      @holt/protocol         types + constants, zero runtime code
  server/      @velvet-thunder/holt   the published npm package (CLI, Vite plugin, core)
  extension/   @holt/extension        the Chrome extension (built with esbuild, loaded unpacked)
examples/
  vite-app/    a tiny app to try holt against
docs/
  ARCHITECTURE.md  this file
  SECURITY.md      threat model and the rules the code follows
```

pnpm workspaces link the packages together. `@holt/protocol` has no build
step: the other packages import its TypeScript source directly and their own
bundlers (tsup for the server, esbuild for the extension) compile it in.

## The server package (`packages/server`, published as `@velvet-thunder/holt`)

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
    vite/        @velvet-thunder/holt/vite: Vite plugin that mounts the handler on the dev server
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
  know an origin, and in Vite-plugin mode that origin is the page's own,
  which is how the extension finds the server without being told (see
  "Finding the server" below).
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

One capture is one entry: a single list item with the user's words, the
media file (if any), then the page it was taken on. Those words are the
entry's `note` on every kind (typed in the note prompt after a screenshot,
or dictated and reviewed for a recording or voice note). Entries carry no
heading, number, time, kind label or icon; the file name says what the
file is. Words that stop on a letter or digit get a full stop.

```markdown
# QA session 2026-10-13 07:52

- Started: 2026-10-13T07:52:00-07:00
- Project: /Users/you/app

---

- Submit button overlaps the footer on narrow widths. ![Screenshot 1](./001-screenshot.png) Page: [Checkout – My App](http://localhost:5173/checkout)
- Coupon field accepts whitespace-only input. Page: [Checkout – My App](http://localhost:5173/checkout)
- The quantity stepper jumps by two when I click fast. Page: [Cart – My App](http://localhost:5173/cart)
- Here I add two items and the total doesn't update. [Recording 4](./004-recording.webm) (0:42) Page: [Cart – My App](http://localhost:5173/cart)
```

A voice note links its audio (`[audio](./005-voice-note.webm) (0:12)`)
only when the user keeps audio (off by default) or nothing was recognised.
A screenshot nobody wrote anything about is just the image and the page.
A note of several lines keeps its line breaks, indented under the item,
and the media and page go on their own indented line after it.

Files can be numbered out of order, deliberately. A media file's number is
reserved when it is uploaded (`003-screenshot.png`), but the entry is
appended only when it is posted. A screenshot is uploaded before its note
prompt opens and posted when the prompt closes, so anything posted in
between (an Alt+T note, say) lands above it. We accept that rather than
reorder: notes.md is append-only and never read back or rewritten, so a
crash can lose at most the entry being written.

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
                  MediaRecorder), both with a live Web Speech transcript of
                  the microphone (unless transcription is off in the
                  settings: then no recogniser is started), and uploads what
                  they record once the user has reviewed the transcript.
                  Survives the side panel being closed.
  menu/           menu.html, the toolbar action's popup: the capture items
                  (each runs the same command as its shortcut; Quick note
                  turns the menu into the note popup) or, while recording,
                  only Stop; and Settings, which opens the panel.
  sidepanel/      the "settings panel", optional: server/session status
                  for the page in front, this session's entries, settings
                  (server mode + URL, token, transcription, keep audio,
                  microphone).
  note/           note.html, the Alt+T quick-note popup, and the note
                  prompt after a screenshot (same page, in a popup window,
                  with Skip and dictation).
  content/        injected on demand with chrome.scripting.executeScript
                  (never declared in the manifest): the area-select overlay,
                  the scroll helper for full-page capture, and the editable
                  transcript box shown during a recording. Runs in the
                  page's world, so it is kept small, validated by the worker,
                  and talks only to the service worker.
  shared/         typed message bus between the contexts, settings, the
                  chrome.storage.session wrapper, MediaRecorder helpers, the
                  server API client, and which server a tab's captures go to
                  (server-resolve.ts, server.ts). The client is shared because Blobs
                  cannot be passed between extension contexts cheaply:
                  whoever records something uploads it.
  permissions/    a plain extension page opened in a tab when the microphone
                  is needed: the offscreen document can never show a
                  permission prompt (it is invisible), a tab can. Also shows
                  the transcription switch and what it sends to Google.
  welcome/        welcome.html, opened once in a tab by the worker on
                  runtime.onInstalled with reason "install" (not on
                  updates): that holt needs the local server, a live check
                  of the fixed/fallback URL, the current shortcuts
                  (chrome.commands.getAll) and the transcription switch.
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
  must be called before the first `await` in a command or click handler:
  the menu's Settings item looks up its window id when the menu opens, so
  the click handler can call it right away. Clicking the toolbar icon opens
  the menu (`action.default_popup`), and opening an action's popup counts
  as invoking the action, so it grants `activeTab` for the tab: the menu's
  captures rely on that. (The declarative `openPanelOnActionClick` flag
  stays off; it would route the click to the panel instead.
  `tabCapture.getMediaStreamId` and `captureVisibleTab` only need the
  activeTab grant, which outlives the gesture; `action.openPopup` is called
  synchronously anyway.)
- **Offscreen documents only get `chrome.runtime`.** No storage, no action,
  no tabs. So the worker sends the recorder everything it needs (server
  URL, token, transcribe/keep-audio, microphone, page context) with each start request, and the
  recorder reports state changes, saved entries and errors back by message;
  the worker updates storage.session, the indicator and the toasts.

### Settings

`chrome.storage.local`, this device only, readable only by the worker and
extension pages (shared/settings.ts):

| key | default | |
| --- | --- | --- |
| `serverMode` | `"auto"` | `"auto"`: find the server from the page (below); `"fixed"`: always `serverUrl` |
| `serverUrl` | `http://127.0.0.1:4848` | the fallback in auto mode, the only server in fixed mode |
| `token` | `""` | sent as `x-holt-token` when set |
| `transcribe` | `true` | live transcripts with Chrome's speech recognition, which sends the audio to Google. `false`: no recogniser anywhere (voice notes, narration, dictation), tab recordings don't open the microphone, and voice notes always keep their audio |
| `keepAudio` | `false` | upload voice notes' audio too, not just the words (always, whatever this says, while `transcribe` is off or nothing was recognised: `keepsVoiceAudio`) |
| `microphoneId`, `microphoneLabel` | system default | the microphone for voice notes and dictation |
| `hideShortcutHint` | `false` | the panel's one-time shortcut tip was dismissed |

### Finding the server

In Vite-plugin mode the server is the page's own origin, so the extension
looks there first instead of making users type URLs
(shared/server-resolve.ts, pure and unit-tested; shared/server.ts wires it
to Chrome):

```
serverMode "fixed"                          -> serverUrl            ("fixed")
tab URL is http://localhost:* or http://127.0.0.1:*
  and GET <origin>/__holt/status is holt    -> the tab's origin     ("tab")
  not holt now, but was holt before         -> an error, no fallback
otherwise                                   -> serverUrl            ("fallback")
```

- **Only the hosts in host_permissions are probed:** `http://localhost`
  and `http://127.0.0.1`, any port. Those are the only tabs whose URL the
  worker can read without the `tabs` permission (besides the tab the user
  just invoked holt on), and the only origins it may fetch from. Other
  loopback names (`*.localhost`, `[::1]`, `127.0.0.2`, https) are not
  probed: without a host permission the worker could neither see such a
  tab's URL nor talk to a server there, so they use the fallback. Other
  sites are never asked.
- **The probe** is the API client's `GET /status` with a 1.5 s timeout and
  without the token; only a body with `ok: true, name: "holt"` counts, or
  holt's own `forbidden` error (a holt server that wants the token).
- **Cached per origin** in storage.session (`serverProbes`): a positive
  answer for 15 s, a negative one for 5 s.
- **Once holt, never a fallback.** Every origin that has answered as holt
  is remembered for the browser session (`holtOrigins` in
  storage.session). If it stops answering (the 1.5 s timeout, Vite
  restarting), a capture there fails with "holt on <origin> isn't
  answering" instead of falling back: the fallback URL may be another
  project's server, and the capture would land in the wrong repository.
- **Pinned per capture.** Each capture resolves once, against the tab it
  captures, and keeps that server to the end: a screenshot's
  `pendingScreenshot.serverUrl` is where its entry is posted after the note
  prompt; a recording's start request hands the offscreen document the URL,
  which it uploads to even if the tab navigates; a quick note's
  `noteContext.serverUrl` is resolved by the worker just after the popup
  opens (the popup had to open synchronously).
- **Known gap:** Vite behind another backend (Rails, Laravel, Django)
  serves pages from the backend's origin, which has no `/__holt`, so those
  pages use the fallback URL; set it to the Vite dev server's URL.

The worker also keeps `serverInfo` in storage.session up to date: the
server for the active tab of the last focused normal window, and whether it
answered `GET /status` as holt with our token ("connected"). It re-checks
only on events, never on a timer: worker start, `tabs.onActivated`,
`windows.onFocusChanged`, `tabs.onUpdated` (a finished page load in an
active tab, if it or the previous page is local), settings changes, and a
`server-info:refresh` request from the toolbar menu (when it opens) or the
side panel (when its own 3 s poll sees the server come or go). The toolbar
badge and the menu's header read it; the side panel resolves and polls for
its own window itself.

### Headless mode: recording from a shortcut

```
 Alt+R ──▶ worker: getMediaStreamId({ targetTabId }) ──┐
                   write recordingScreen (storage.session)
                   ensure offscreen doc (one per extension)
                   "offscreen:start-tab" { streamId, page, settings } ──▶ offscreen:
                                                          getUserMedia(chromeMediaSource: "tab")
                                                          AudioContext: play tab audio back
                                                          MediaRecorder …
                                                          + microphone → Web Speech
                                                          "recorder:transcript" ──▶ worker ──▶ transcript box on the page
 Alt+R ──▶ worker: "offscreen:stop" ─────────────────────────▶ stop, "recorder:stopped" ──▶ worker clears state
                                                          "recorder:finished" { transcript } ──▶ worker
          worker ──"voice-overlay:finish"──▶ box: untouched? closes (save as recognised)
                                                  clicked into / edited? stays for review,
                                                  later "voice-overlay:decision" { save, text }
          worker ──"offscreen:commit" { save, transcript }──▶ offscreen:
                                                          POST /media, POST /entries
                                                          "entry-created" ──▶ worker: recent list,
                                                                              panel toast or badge ✓
                                                          "recorder:idle" ──▶ worker closes the doc
```

The toolbar menu's items send `menu:run` to the worker, which runs the same
command handler as the shortcut, so they take exactly this path. The
worker decides start or stop one press at a time (a queue in
recording.ts), so two quick presses can't start two recordings; a
recording the offscreen document runs without state pointing at it (a
worker died between clearing the state and stopping it) is stopped, and
thereby saved, at the next worker start (`offscreen:status`). The box's
edits are mirrored to storage.session (`transcriptBoxes`) so a navigation
mid-recording doesn't lose them; a stopped recording waits in the offscreen
document until the commit arrives (at most an hour, then it is saved as
recognised).

The toolbar icon is the status indicator: "REC"/"MIC" badge, a red dot drawn on the icon, and a tooltip
like "holt (acme-web): recording tab since 14:02 (⌥R to stop)". It is
browser UI, so it never appears in screenshots or tab recordings. When
nothing is recording and `serverInfo` says no server answers for the page
in front, the badge is a red "!" ("holt: no server for this page — …"),
but only on local (loopback) pages: elsewhere there is nothing to detect,
and a permanently red icon while browsing would be noise. The toolbar menu
explains the problem on any page, with an "Open settings" button.

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
4. Worker resolves the server for the tab, `POST /media` (bytes) → gets
   `file`, stores `pendingScreenshot` (with that server's URL) in
   storage.session and opens the note prompt (note.html in a popup
   window: the gesture is long gone, so `action.openPopup` is not an
   option).
5. The user types or dictates a note and presses Enter (or Skip, or Esc,
   which skips only while nothing is typed). The prompt sends
   `screenshot-note:finish`; the worker clears `pendingScreenshot` and
   `POST /entries` with the one ScreenshotEntry referencing `file`, with
   the `note` if there is one. While the user types, the prompt mirrors the
   text into `pendingScreenshot.draft` (`screenshot-note:draft`, debounced).
   A screenshot is never left behind, and neither are the words: closing
   the window, the next screenshot, or a new worker finding an abandoned
   one posts it with the draft as its note. `pendingScreenshot` is also
   backed up in storage.local, so quitting the browser with the prompt open
   posts it at the next start. If the server refuses the entry for good (a
   4xx: the session changed under the prompt, so `file` is no longer an
   unused upload of the current session), the screenshot is dropped from
   the notes and the user's words are posted as a separate note naming the
   file; Skip always closes. Shortcuts pressed while the prompt is in front
   (it opens focused) are retargeted to the screenshot's tab, or the active
   tab of the last focused normal window.
6. Worker broadcasts "entry added" → side panel updates its list (or, with
   the panel closed, the toolbar badge flashes "✓").

## Why a toolbar menu instead of in-page buttons

Buttons injected into the page would need a content script on every site
(broad host permissions), fight with the page's CSS, reload on every
navigation, and show up in screenshots and tab recordings. The toolbar menu
and the side panel are extension pages: no access to the page needed, their
own origin (so microphone permission is asked once, for the extension), and
never part of a capture. For the same reasons the "recording" indicator is
the toolbar icon. The one exception is the transcript box: the user edits
while looking at the page, so it is on the page, injected only into the tab
being recorded, for as long as the recording (and its review) lasts.

## Configuration

`holt.config.json` in the project root (all keys optional):

```json
{
  "$schema": "./node_modules/@velvet-thunder/holt/schema.json",
  "outputDir": "qa",
  "port": 4848,
  "host": "127.0.0.1",
  "maxUploadBytes": 209715200,
  "sessionTitle": "QA session",
  "projectName": "acme-web"
}
```

(`projectName` has no fixed default: when it is unset the server uses the
package.json name or the directory name, as described above. `token` can
be set here too, but this file is usually committed: set it in the
`HOLT_TOKEN` environment variable instead, which takes precedence over the
file.)

The config loader validates every key by hand (no schema library at runtime)
and prints a clear message naming the bad key. The JSON schema file is shipped
only for editor autocomplete.
