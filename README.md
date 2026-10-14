# holt

Unobtrusive screenshots, screen recordings, and voice or typed notes for
QA-ing your own app, written straight into your repo as markdown.

_Named for Captain Raymond Holt of Brooklyn Nine-Nine, who would also like a word about that misaligned button._

```
qa/2026-10-13-075200/
  notes.md
  001-screenshot.png
  002-recording.webm
```

You click through your app and capture from holt's toolbar menu (or just use
hotkeys). Every capture lands in one `notes.md` with the page URL, a
timestamp, and whatever you said or typed about it. Hand the folder to a
teammate, paste it into an issue, or point your coding agent at it.

## How it works

Two pieces:

1. **A local server** (this npm package) that receives captures and writes
   files. Run it standalone with `npx holt` (or `npx @velvet-thunder/holt` without
   installing), or add the Vite plugin
   so it rides along with your dev server.
2. **A Chrome extension** that captures screenshots, records the screen and
   microphone, and sends everything to the server.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and
[docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Quick start

```bash
npm i -D @velvet-thunder/holt
```

Vite:

```ts
// vite.config.ts
import holt from "@velvet-thunder/holt/vite";
export default { plugins: [holt()] };
```

Anything else:

```bash
npx holt
```

Then load the extension (see [packages/extension/README.md](packages/extension/README.md))
and click holt's toolbar icon on your app. There is nothing to configure:

- **Vite plugin:** the extension finds holt on its own on every page your
  dev server serves (it asks the page's origin for `/__holt/status`, only
  on `localhost`/`127.0.0.1`).
- **`npx holt`:** the extension's fallback server URL is
  `http://127.0.0.1:4848`, which is where `npx holt` listens by default.

Two setups need the URL in the extension's settings (holt's menu →
**Settings** → Server): a standalone server on another port, and Vite
running behind another backend (Rails, Laravel, Django, ...) that serves
the pages from its own origin, so the page's origin is not the Vite dev
server. Set the fallback URL to the server holt runs on, e.g.
`http://localhost:5173`, or pick **Always use this URL**.

When no holt server answers for the local page you are on, the toolbar icon
shows a red **!**, and holt's menu says why.

## Repository

pnpm monorepo:

| path | what |
| --- | --- |
| `packages/shared` | `@holt/protocol`: types and constants shared by both halves |
| `packages/server` | `@velvet-thunder/holt`: the published package (CLI, Vite plugin, core) |
| `packages/extension` | the Chrome extension (Manifest V3) |
| `examples/vite-app` | a small app to try it on |

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
