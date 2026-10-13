# Security notes

nitpick is a local tool that writes files into your repository on request
from a browser extension. That combination deserves a clear threat model.
This document describes what the code defends against, what it deliberately
does not, and what you should know before changing the defaults.

## Threat model in one paragraph

The server trusts two things: the loopback interface, and the Chrome
extension. Everything else is hostile: web pages you visit (including the
app you are testing), other extensions, other users on the same machine,
and the network. The extension trusts the server it is pointed at and its
own pages; it treats every web page, including ones it injects scripts
into, as hostile.

## What the server protects against

1. **A web page writing into your repo.** Any page can `fetch()`
   `http://127.0.0.1:4848`. Three checks stop it:
   - Every request must carry the custom `x-nitpick-client` header. Browsers
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
4. **Exposure on the network.** The server binds to `127.0.0.1` by default.
   The Host and Origin checks only stop browsers; any other program can
   forge both headers. So the shared `token` is the only real defense
   against non-browser clients, and the server refuses to bind to a
   non-loopback address unless a token is set. Requests from non-loopback
   sockets are rejected outright when no token is configured.
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

## What the server deliberately trusts

- **Other users and processes on your machine.** Anything on loopback with
  no `Origin` header is accepted unless a token is set. On a shared machine
  or a container that shares the host's loopback interface, set a `token`.
- **Every installed Chrome extension.** Any `chrome-extension://` origin
  passes by default, because extension IDs differ per install and we cannot
  know yours in advance. Set `allowedExtensionIds` to pin writes to yours.
  This cannot protect `GET /status`, which arrives with no `Origin`; only a
  token does.
- **Anything you list in `allowedOrigins`.** Listing the app under test
  gives every script that runs on that app, including third-party ones,
  write access. Prefer not to.
- **A committed `nitpick.config.json`.** It can widen `host`,
  `allowedOrigins`, and `allowedExtensionIds`. The server logs each of these
  loudly at startup so a surprising value is visible.

## Vite plugin mode

The API is mounted on your Vite dev server, so it is exposed exactly as far
as Vite is. Two consequences:

- If you run Vite with `--host` (non-loopback) the API is on your LAN. The
  plugin warns, and the token rule above applies.
- Vite serves your project root statically, which includes the session
  folder. The plugin returns 404 for any request into `outputDir`, and the
  peer range requires Vite 5.4.12 or newer because older versions answered
  CORS requests with `*`, which would have let any website read captures by
  guessing the timestamp-based folder names.

## The extension

- Permissions are the minimum: `activeTab`, `sidePanel`, `scripting`,
  `storage`, plus host permissions for `127.0.0.1` and `localhost` only. No
  `tabs`, no `<all_urls>`, no `web_accessible_resources`, no
  `externally_connectable`. The default Manifest V3 content security policy
  applies, and the side panel never uses `innerHTML`.
- Content scripts run inside hostile pages. The worker only accepts
  `area-selected` from the top frame of the tab it injected into, and only
  accepts capture requests and panel-bound messages from the extension's
  own pages. Settings storage is set to `TRUSTED_CONTEXTS` so a content
  script cannot read the token or repoint the server URL.
- The server URL and token are stored in `chrome.storage.local`, never
  synced to your Google account.

## What this does not protect against

- Someone with shell access as your user. They can edit your repo directly.
- The content of screenshots and recordings. They capture whatever is on
  screen, and page URLs are written with their query strings and fragments,
  so an OAuth code or token in a URL will land in `notes.md`. When nitpick
  creates the output directory it writes a `.gitignore` there so sessions
  are not committed unless you decide to. If the directory already existed,
  nitpick leaves your ignore rules alone.
- Renderers of `notes.md`. GitHub, for example, autolinks bare `www.` text.
  Escaping prevents images and HTML; it cannot prevent a renderer from
  being helpful with plain text.
