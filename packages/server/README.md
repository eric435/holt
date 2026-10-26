# holt

The local server half of **holt**: take screenshots, record your screen,
and dictate or type notes while clicking through your own app, and get all of
it as one markdown file (plus media) inside your repo.

```
qa/2026-10-13-075200/
  notes.md
  001-screenshot.png
  002-recording.webm
```

This package receives captures from the holt Chrome extension over
localhost HTTP and writes the files. It has **zero runtime dependencies**.

## Install

```bash
npm i -D @velvet-thunder/holt
# or: pnpm add -D @velvet-thunder/holt / yarn add -D @velvet-thunder/holt
```

Requires Node.js 22 or newer.

## Run it

### Standalone (any stack)

```bash
npx holt
```

The package installs a command named `holt`. Once it is a dev dependency,
`npx holt` (or `pnpm holt`) runs it. To try it without installing, use
`npx @velvet-thunder/holt`.

```
[holt] v0.0.1 serving my-app (from package.json) at http://127.0.0.1:4848/__holt
[holt] Writing sessions to /path/to/app/qa
[holt] Connect: nothing to set up. This is the holt extension's default server URL.
```

Options:

```
holt [--port <n>] [--host <host>] [--out <dir>] [--project-name <name>]
     [--config <file>] [--token <secret>]
holt init [--force]   write a starter holt.config.json
holt --help | --version
```

Flags override the environment, which overrides `holt.config.json`, which
overrides the defaults. The one environment variable is `HOLT_TOKEN`: if you
need a token, put it there rather than in `holt.config.json` (usually
committed) or on the command line (visible to other processes, kept in shell
history). Ctrl+C ends the active session cleanly.

### Vite plugin

```ts
// vite.config.ts
import { defineConfig } from "vite";
import holt from "@velvet-thunder/holt/vite";

export default defineConfig({
  plugins: [holt()],
});
```

The API is mounted on Vite's dev server at `/__holt`. The extension
detects it by itself on every page that dev server serves (it asks the
page's origin for `/__holt/status`, on loopback hosts only), so there is
nothing to configure. If your pages are served by another backend that uses
Vite only for assets (Rails, Laravel, Django, ...), the page's origin is not
Vite's: set the extension's fallback server URL to the dev server's URL
(e.g. `http://localhost:5173`); the startup banner prints it. The plugin
does nothing during `vite build`. Options are the same keys as the config file
(`port` and `host` are ignored; Vite owns the socket), plus `configFile`.

Under the plugin, holt only answers requests from this machine, even when
you run `vite --host` and set a token (the plugin warns when Vite listens on
the network). To use holt from another machine, run the standalone server
with `--host <addr>` and a token.

The plugin also stops Vite from serving the output directory and
`holt.config.json`: with the default `outputDir: "qa"` inside your project,
Vite would otherwise serve every screenshot and `notes.md` at `/qa/...`, and
the config file (with any token in it) at `/holt.config.json`, to anything
that can reach the dev server.

**Requires Vite 5.4.12+ (5.x), 6.0.9+, 7 or 8** (the `vite` peer
dependency range is `^5.4.12 || ^6.0.9 || ^7.0.0 || ^8.0.0`, the majors CI
tests). Earlier versions, including 6.0.0 to 6.0.8, answer
every dev-server request with `Access-Control-Allow-Origin: *`
([GHSA-vg6x-rcgg-rjx6](https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6)),
so any web page you visit could read your app's source through the dev
server. Vite is an optional peer: you only need
it if you use `@velvet-thunder/holt/vite`.

### Programmatic

```ts
import http from "node:http";
import { createHolt } from "@velvet-thunder/holt";

const holt = await createHolt({ cwd: process.cwd() });
http.createServer(async (req, res) => {
  if (await holt.handler(req, res)) return; // handled /__holt/*
  // ...your own routes
}).listen(3000, "127.0.0.1");
```

`handler(req, res)` resolves to `false` for paths outside `/__holt`, so it
drops into any node:http or connect-style middleware chain.

## Configuration

`holt.config.json` in your project root. Every key is optional. Run
`npx holt init` to create one with the defaults and a `$schema` for editor
autocomplete.

```json
{
  "$schema": "./node_modules/@velvet-thunder/holt/schema.json",
  "outputDir": "qa",
  "sessionTitle": "QA session"
}
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `outputDir` | string | `"qa"` | Where session folders go, relative to the project root. |
| `port` | integer | `4848` | Standalone server port. Ignored by the Vite plugin. |
| `host` | string | `"127.0.0.1"` | Interface the standalone server binds to. A non-loopback host requires a token. Ignored by the Vite plugin. |
| `token` | string \| null | `null` | Shared secret the extension must send (`x-holt-token`). Required for requests from other machines. Prefer the `HOLT_TOKEN` environment variable: this file is usually committed. `--token` and plugin options win over `HOLT_TOKEN`, which wins over this key; an empty `HOLT_TOKEN` counts as unset. `holt init` leaves this key out. |
| `maxUploadBytes` | integer | `209715200` (200 MiB) | Size limit for one screenshot or recording. |
| `sessionTitle` | string | `"QA session"` | H1 title for new sessions. |
| `projectName` | string | `name` from `./package.json`, else the directory name | Name the extension shows for this server ("my-app at http://127.0.0.1:4848"), so you can tell several apart. At most 100 characters, no control characters. Parent directories are not searched. |
| `allowedOrigins` | string[] | `[]` | Extra exact web origins allowed to call the API. |
| `allowedExtensionIds` | string[] | `[]` | Extension IDs allowed to call the API. Empty allows any `chrome-extension://` origin. |

Invalid values stop the server with a message naming the key; unknown keys
log a warning. Every `allowedOrigins` and `allowedExtensionIds` entry, and a
non-default `host`, is logged at startup.

**Pinning the extension:** by default any installed Chrome extension may call
the server. To allow only yours, copy its ID from `chrome://extensions` into
`allowedExtensionIds`. Which ID that is depends on how holt is installed: an
unpacked build (Load unpacked) gets its own ID per install, so pin it in a
local, uncommitted config; every install from the Chrome Web Store has the
same ID (the store's), so pinning that one works for the whole team, in a
committed `holt.config.json` too. `holt init` leaves this key out:

```json
{ "allowedExtensionIds": ["abcdefghijklmnopabcdefghijklmnop"] }
```

## Output

Each session is a folder named `YYYY-MM-DD-HHMMSS` (local time) inside
`outputDir`. A session starts when you press "start" in the extension, or
automatically with your first capture. Starting a new session ends the
previous one. `notes.md` is append-only:

```markdown
# QA session 2026-10-13 07:52

- Started: 2026-10-13T07:52:00-07:00
- Project: /Users/you/app

---

- Submit button overlaps the footer on narrow widths. ![Screenshot 1](./001-screenshot.png) Page: [Checkout – My App](http://localhost:5173/checkout)
- Coupon field accepts whitespace-only input. Page: [Checkout – My App](http://localhost:5173/checkout)

---

_Session ended at 2026-10-13T08:10:00-07:00 (2 entries)._
```

When holt creates the output directory, it puts a `.gitignore` in it so
sessions are not committed by default (screenshots can contain anything that
was on screen). Delete that file if you want to commit sessions.

## Updating, and extension compatibility

The extension updates itself from the Chrome Web Store, while your project
pins this package, so the two are often from different releases. They agree
on a protocol version, which `GET /__holt/status` reports as
`protocolVersion` (also exported as `PROTOCOL_VERSION`). It only changes for
breaking changes, so most extension and server releases work together.

When they don't match, the extension says so before it captures anything
(the toolbar icon's red "!", its menu, the settings panel), and which side
to update:

- the server is too old: update it with `npm i -D @velvet-thunder/holt@latest`
  (if you run it with npx: `npx @velvet-thunder/holt@latest`), then restart
  it, or the Vite dev server;
- the extension is too old: update it at `chrome://extensions` (Developer
  mode, then Update) or wait for Chrome to.

A capture of a kind this server doesn't know yet (new kinds do not change
the protocol version) is refused with a 400 that says the extension is
probably newer than the server and how to update it; the extension shows
that message.

## Security

The server writes files into your repo on request, so it is locked down by
default:

- Binds to `127.0.0.1`. Requests from other machines are refused unless a
  token is set, and the standalone server will not even start on a
  non-loopback `host` without one. Under the Vite plugin, only requests
  from this machine are answered.
- Rejects requests whose `Host` is not a loopback name (DNS rebinding).
- Only `chrome-extension://` origins (optionally pinned with
  `allowedExtensionIds`, plus any you list in `allowedOrigins`) may call it.
  Every request needs an `x-holt-client` header, which forces a CORS
  preflight that web pages fail. Requests with no `Origin` are accepted only
  from non-browser clients (curl) on this machine.
- Optional shared token, best kept in the `HOLT_TOKEN` environment variable.
- The server picks every file name; the extension never sends paths. Every
  write is checked to stay inside the session folder.
- Upload and JSON body size limits; uploads stream to disk; at most 50
  uploads may wait for their entry per session.
- In Vite mode, the dev server does not serve the output directory or
  `holt.config.json`.
- Page titles, URLs and notes are escaped before they go into markdown.
- No runtime dependencies.

Full threat model: [docs/SECURITY.md](https://github.com/eric435/holt/blob/main/docs/SECURITY.md).

## License

MIT
