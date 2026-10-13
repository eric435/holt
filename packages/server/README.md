# nitpick-notes

The local server half of **nitpick**: take screenshots, record your screen,
and dictate or type notes while clicking through your own app, and get all of
it as one markdown file (plus media) inside your repo.

```
qa/2026-10-13-075200/
  notes.md
  001-screenshot.png
  002-recording.webm
  003-voice-note.webm
```

This package receives captures from the nitpick Chrome extension over
localhost HTTP and writes the files. It has **zero runtime dependencies**.

## Install

```bash
npm i -D nitpick-notes
# or: pnpm add -D nitpick-notes / yarn add -D nitpick-notes
```

Requires Node.js 20 or newer.

## Run it

### Standalone (any stack)

```bash
npx nitpick-notes
```

(Once installed locally, `npx nitpick` works too. Before installing, use the
full package name: `nitpick` on its own is a different npm package.)

```
[nitpick] v0.1.0 listening on http://127.0.0.1:4848/__nitpick
[nitpick] Writing sessions to /path/to/app/qa
[nitpick] Connect: open the nitpick extension's side panel and set the server URL to http://127.0.0.1:4848
```

Options:

```
nitpick [--port <n>] [--host <host>] [--out <dir>] [--config <file>] [--token <secret>]
nitpick init [--force]    write a starter nitpick.config.json
nitpick --help | --version
```

Flags override `nitpick.config.json`, which overrides the defaults. Ctrl+C
ends the active session cleanly.

### Vite plugin

```ts
// vite.config.ts
import { defineConfig } from "vite";
import nitpick from "nitpick-notes/vite";

export default defineConfig({
  plugins: [nitpick()],
});
```

The API is mounted on Vite's dev server at `/__nitpick`, so point the
extension at your dev server's URL (e.g. `http://localhost:5173`). The plugin
does nothing during `vite build`. Options are the same keys as the config file
(`port` is ignored; Vite owns the port), plus `configFile`.

The plugin also stops Vite from serving the output directory: with the
default `outputDir: "qa"` inside your project, Vite would otherwise serve
every screenshot and `notes.md` at `/qa/...` to anything that can reach the
dev server.

**Requires Vite 5.4.12 or newer** (the `vite` peer dependency range is
`>=5.4.12`). Earlier versions answer every dev-server request with
`Access-Control-Allow-Origin: *`, so any web page you visit could read your
app's source through the dev server. Vite is an optional peer: you only need
it if you use `nitpick-notes/vite`.

### Programmatic

```ts
import http from "node:http";
import { createNitpick } from "nitpick-notes";

const nitpick = await createNitpick({ cwd: process.cwd() });
http.createServer(async (req, res) => {
  if (await nitpick.handler(req, res)) return; // handled /__nitpick/*
  // ...your own routes
}).listen(3000, "127.0.0.1");
```

`handler(req, res)` resolves to `false` for paths outside `/__nitpick`, so it
drops into any node:http or connect-style middleware chain.

## Configuration

`nitpick.config.json` in your project root. Every key is optional. Run
`npx nitpick init` to create one with the defaults and a `$schema` for editor
autocomplete.

```json
{
  "$schema": "./node_modules/nitpick-notes/schema.json",
  "outputDir": "qa",
  "token": null
}
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `outputDir` | string | `"qa"` | Where session folders go, relative to the project root. |
| `port` | integer | `4848` | Standalone server port. Ignored by the Vite plugin. |
| `host` | string | `"127.0.0.1"` | Interface to bind. A non-loopback host requires a `token`. |
| `token` | string \| null | `null` | Shared secret the extension must send (`x-nitpick-token`). Required for requests from other machines. |
| `maxUploadBytes` | integer | `209715200` (200 MiB) | Size limit for one screenshot or recording. |
| `sessionTitle` | string | `"QA session"` | H1 title for new sessions. |
| `allowedOrigins` | string[] | `[]` | Extra exact web origins allowed to call the API. |
| `allowedExtensionIds` | string[] | `[]` | Extension IDs allowed to call the API. Empty allows any `chrome-extension://` origin. |

Invalid values stop the server with a message naming the key; unknown keys
log a warning. Every `allowedOrigins` and `allowedExtensionIds` entry, and a
non-default `host`, is logged at startup.

**Pinning the extension:** by default any installed Chrome extension may call
the server. To allow only yours, copy its ID from `chrome://extensions` into
`allowedExtensionIds` (`nitpick init` leaves this key out because the ID
differs per install):

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

## 1. Screenshot · 07:53:12
Page: [Checkout – My App](http://localhost:5173/checkout)

![Screenshot 1](./001-screenshot.png)

> Submit button overlaps the footer on narrow widths.

## 2. Note · 07:54:01
Page: [Checkout – My App](http://localhost:5173/checkout)

Coupon field accepts whitespace-only input.

---

_Session ended at 2026-10-13T08:10:00-07:00 (2 entries)._
```

When nitpick creates the output directory, it puts a `.gitignore` in it so
sessions are not committed by default (screenshots can contain anything that
was on screen). Delete that file if you want to commit sessions.

## Security

The server writes files into your repo on request, so it is locked down by
default:

- Binds to `127.0.0.1`. Requests from other machines are refused unless a
  `token` is set, and the standalone server will not even start on a
  non-loopback `host` without one.
- Rejects requests whose `Host` is not a loopback name (DNS rebinding).
- Only `chrome-extension://` origins (optionally pinned with
  `allowedExtensionIds`, plus any you list in `allowedOrigins`) may call it.
  Every request needs an `x-nitpick-client` header, which forces a CORS
  preflight that web pages fail. Requests with no `Origin` are accepted only
  from non-browser clients (curl) on this machine.
- Optional shared `token`.
- The server picks every file name; the extension never sends paths. Every
  write is checked to stay inside the session folder.
- Upload and JSON body size limits; uploads stream to disk; at most 50
  uploads may wait for their entry per session.
- In Vite mode, the output directory is not served by the dev server.
- Page titles, URLs and notes are escaped before they go into markdown.
- No runtime dependencies.

Full threat model: [docs/SECURITY.md](https://github.com/OWNER/nitpick/blob/main/docs/SECURITY.md).

## License

MIT
