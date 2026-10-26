# Security notes

holt is a local tool that writes files into your repository on request
from a browser extension. That combination deserves a clear threat model.
This document describes what the code defends against, what it deliberately
does not, and what you should know before changing the defaults.

## Threat model in one paragraph

The server trusts two things: the loopback interface, and the Chrome
extension. Everything else is hostile: web pages you visit (including the
app you are testing), other extensions, other users on the same machine,
and the network. The extension trusts the server it is pointed at (or
finds on a loopback page's origin, see "Finding the server" below) and its
own pages; it treats every web page, including ones it injects scripts
into, as hostile.

## What the server protects against

1. **A web page writing into your repo.** Any page can `fetch()`
   `http://127.0.0.1:4848`. Three checks stop it:
   - Every request must carry the custom `x-holt-client` header. Browsers
     cannot send a custom header cross-origin without a CORS preflight, and
     the server only answers the preflight for `chrome-extension://`
     origins (or ones listed in `allowedOrigins`).
   - The `Origin` header, when present, must be an allowed origin.
   - The `Host` header must name a loopback host. This defends against DNS
     rebinding: an attacker's domain re-resolves to 127.0.0.1 so their page
     becomes same-origin with the server and the browser sends no `Origin`,
     but `Host` still says `evil.example`.
   - Requests with no `Origin` at all are accepted only from a loopback
     socket, and only if they carry no `Sec-Fetch-*` headers or say
     `Sec-Fetch-Site: none`. Browsers always send those headers and pages
     cannot forge them; a script on the app under test sends `same-origin`,
     so it cannot read `/status` with a same-origin GET in Vite mode. The
     `none` exception exists because Chrome sends the extension's own
     `GET /status` with no `Origin` and `Sec-Fetch-Site: none`. (Side
     effect: Node's built-in `fetch` sends `Sec-Fetch-Mode`, so use curl or
     `node:http` for local testing.)
2. **Path traversal.** The extension never supplies a file name or path. The
   server generates names from a counter and an allow-list of media types,
   and every write path is resolved and checked to stay inside the session
   directory. The check is lexical, not a symlink-resolved realpath; that is
   enough because the server itself chooses every path component. Files are
   created with the `wx` flag so an existing file or a planted symlink is
   never overwritten or followed.
3. **Disk exhaustion by a single request.** Uploads are streamed to disk
   with a byte cap (`maxUploadBytes`), JSON bodies have a small separate
   cap, and a partial file is deleted on abort. At most 50 uploads per
   session may wait for their entry; the next one gets a 429. There is no *total* quota across sessions: a trusted
   client can still fill a disk by making many requests.
4. **Exposure on the network.** The standalone server binds to `127.0.0.1`
   by default. The Host and Origin checks only stop browsers; any other
   program can forge both headers. So the shared `token` is the only real
   defense against non-browser clients, and the server refuses to bind to a
   non-loopback address unless a token is set. Requests from non-loopback
   sockets are rejected outright when no token is configured. Keep the
   token out of `holt.config.json`, which is usually committed: set it in
   the `HOLT_TOKEN` environment variable instead (`--token` and Vite plugin
   options win over `HOLT_TOKEN`, which wins over the file; `holt init`
   does not write a `token` key). Under the Vite plugin the API is
   loopback-only, token or not; see "Vite plugin mode". To use holt from
   another machine, run the standalone server with `--host` and a token.
5. **Supply chain.** The published package has zero runtime dependencies;
   `vite` is an optional peer. CI fails if the packed tarball contains
   anything outside an explicit allow-list, and `publishConfig.provenance`
   is on.
6. **Markdown injection.** Page titles, URLs, notes, and transcripts are
   user-controlled or page-controlled text. The escaper neutralises link
   and image syntax, raw HTML, headings, code fences, setext underlines,
   and thematic breaks, and strips bidirectional-override and zero-width
   characters. Link destinations are only written for `http(s)` URLs and
   are percent-encoded. Emphasis characters are left alone; the worst they
   can do is make text bold.
7. **The project name.** `GET /status` exposes the project name (from
   `projectName`, `package.json`, or the directory name) to the extension,
   which only ever displays it as text. Control, zero-width and bidi
   characters are stripped (or, in `projectName`, rejected) and it is capped
   at 100 characters, so a hostile package.json cannot inject terminal
   escapes into the startup banner.

## What the server deliberately trusts

- **Other users and processes on your machine.** Anything on loopback with
  no `Origin` header is accepted unless a token is set. On a shared machine
  or a container that shares the host's loopback interface, set a token
  (in `HOLT_TOKEN`).
- **Every installed Chrome extension.** Any `chrome-extension://` origin
  passes by default, because extension IDs differ per install and we cannot
  know yours in advance. Set `allowedExtensionIds` to pin writes to yours.
  This cannot protect `GET /status`, which arrives with no `Origin`; only a
  token does.
- **Anything you list in `allowedOrigins`.** Listing the app under test
  gives every script that runs on that app, including third-party ones,
  write access. Prefer not to.
- **A committed `holt.config.json`.** It can widen `host`,
  `allowedOrigins`, and `allowedExtensionIds`. The server logs each of these
  loudly at startup so a surprising value is visible. A `token` written
  there is readable by everyone with access to the repository; that is why
  `HOLT_TOKEN` is the recommended place for it.

## Vite plugin mode

The API is mounted on your Vite dev server, so it is exposed exactly as far
as Vite is. Two consequences:

- Under the plugin, holt's API is loopback-only by design. If you run Vite
  with `--host`, the dev server is on your LAN, but the Host check only
  accepts loopback names (and the configured `host`, which the plugin does
  not bind and which defaults to `127.0.0.1`), while a client on another
  machine sends Vite's LAN address. So it is refused with or without a
  token. The plugin warns whenever Vite listens on a non-loopback address.
  For remote use, run the standalone server: `npx holt --host <addr>`
  with a token.
- Vite serves your project root statically, which includes the session
  folder and `holt.config.json`. The plugin returns 404 for any request
  into `outputDir` and for the config file (the one it loaded, and
  `<root>/holt.config.json` even if it did not exist at startup), however
  the path is spelled: percent-encoded, in another letter case, with `..`
  or backslashes, under `base` or `publicDir`, or through Vite's `/@fs/`
  and `/@id/` prefixes (including Windows drive paths like
  `/@fs/C:/...`). The peer range (`^5.4.12 || >=6.0.9`) excludes every
  Vite release that answered CORS requests with `*` (GHSA-vg6x-rcgg-rjx6:
  before 5.4.12, and 6.0.0 to 6.0.8), which would have let any website
  read captures by guessing the timestamp-based folder names.

## The extension

- Permissions are the minimum: `activeTab`, `sidePanel`, `scripting`,
  `storage`, `offscreen`, `tabCapture`, plus host permissions for
  `127.0.0.1` and `localhost` only. No `tabs`, no `<all_urls>`, no
  `web_accessible_resources`, no `externally_connectable`. The default
  Manifest V3 content security policy applies, and no extension page uses
  `innerHTML`.
- `tabCapture` records a tab's picture and sound. Chrome only issues a
  capture stream id for a tab where the user invoked holt (a shortcut or
  a toolbar click: the activeTab grant, which ends when the tab navigates
  to another page), never for `chrome://` pages, and normally marks
  a captured tab with its own capture indicator in the tab strip. holt
  also shows "REC" on its toolbar icon while it records. `offscreen` only lets the extension create its
  own hidden page (the recorders); it grants no access to anything.
- Microphone access is a per-origin permission the user grants once on
  holt's own permissions page. Voice notes and the live transcript use
  Chrome's speech recognition, which sends audio to Google's speech
  service (see the extension README); the audio file goes only to the
  local server.
- Content scripts run inside hostile pages. The worker only accepts
  `area-selected` from the top frame of the tab it injected into, only
  accepts the toolbar menu's commands, panel-bound messages and the
  screenshot note prompt's answer and draft from the extension's own pages,
  and only believes recorder reports from its own
  offscreen document (checked by sender URL). The offscreen document only
  takes orders from the extension's own pages too, so a page cannot start
  a recording or make the recorder upload somewhere else. Settings storage
  is set to `TRUSTED_CONTEXTS` so a content script cannot read the token or
  repoint the server URL.
- The worker sends the server URL and token to the offscreen document with
  each start request (it has no storage access of its own). Runtime
  messages from an extension page or the worker reach only the extension's
  own pages and worker, never content scripts.
- The server URL and token are stored in `chrome.storage.local`, never
  synced to your Google account. So is, until its entry is written, a
  backup of the screenshot waiting in the note prompt (its page URL and
  title, and what you have typed), so quitting the browser doesn't lose
  it; like the settings, content scripts cannot read it.
- The API client refuses HTTP redirects (`redirect: "error"`), so whatever
  answers on a loopback origin cannot bounce the probe, a capture or the
  token to another host.

### Finding the server (auto-detect)

By default the extension sends a page's captures to that page's own origin
when the page is on `http://localhost` or `http://127.0.0.1` (any port: the
hosts in host_permissions) and that origin answers `GET /__holt/status` as
holt; otherwise to the configured URL (`http://127.0.0.1:4848` unless
changed). An origin that has answered as holt is not given up on for the
rest of the browser session: if it stops answering, captures there fail
rather than go to the configured URL, which may be a different project's
server.
The trade-off: any local process that answers `/__holt/status` like holt on
the origin of a loopback tab gets that tab's screenshots, recordings and
notes, and, because the following requests carry it, the token if you set
one. That is the same trust the extension already placed in whatever
listens on the fixed loopback URL (any local process can bind
`127.0.0.1:4848` first), now extended to the origin of the local page you
are capturing, which is usually your own dev server. What does not change:
only loopback origins are ever probed, so no site on your network or the
internet is asked or sent anything; the probe itself carries the client
header but not the token (holt that requires one answers with its own
`forbidden` error, which is enough to recognise it), so a local server that
is not holt never sees the token; a web page can only influence the choice
through its own origin (it cannot point captures anywhere else, and cannot
read or write the probe cache in `chrome.storage.session`); and each
capture's server is fixed when it starts. If this is not acceptable on your
machine, set **Settings → Server → Always use this URL**: nothing is
probed.

## What this does not protect against

- Someone with shell access as your user. They can edit your repo directly.
- The content of screenshots and recordings. They capture whatever is on
  screen, and page URLs are written with their query strings and fragments,
  so an OAuth code or token in a URL will land in `notes.md`. When holt
  creates the output directory it writes a `.gitignore` there so sessions
  are not committed unless you decide to. If the directory already existed,
  holt leaves your ignore rules alone.
- Renderers of `notes.md`. GitHub, for example, autolinks bare `www.` text.
  Escaping prevents images and HTML; it cannot prevent a renderer from
  being helpful with plain text.
- Prompt injection. Page titles and URLs are controlled by the page you
  capture and are written into `notes.md` verbatim (escaped for Markdown
  only), and the README suggests pointing a coding agent at `notes.md`.
  Escaping cannot stop text that reads like instructions ("ignore the
  above and ..."). Treat `notes.md` as untrusted input to an agent, as you
  would the pages it was captured from.
- Your local paths. The header of every `notes.md` and the `/status`
  response (while a session is active) contain absolute paths of the
  project and session folder, which usually include your OS username.
  Keep that in mind when sharing session folders.
