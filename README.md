# holt

Unobtrusive screenshots, screen recordings, and voice or typed notes for
QA-ing your own app, written straight into your repo as markdown.

_Named for Captain Raymond Holt of Brooklyn Nine-Nine, who would also like a word about that misaligned button._

```
qa/2026-10-13-075200/
  notes.md
  001-screenshot.png
  002-recording.webm
  003-voice-note.webm
```

You click through your app with a small Chrome side panel open (or just use
hotkeys). Every capture lands in one `notes.md` with the page URL, a
timestamp, and whatever you said or typed about it. Hand the folder to a
teammate, paste it into an issue, or point your coding agent at it.

## How it works

Two pieces:

1. **A local server** (this npm package) that receives captures and writes
   files. Run it standalone with `npx holt`, or add the Vite plugin
   so it rides along with your dev server.
2. **A Chrome extension** that captures screenshots, records the screen and
   microphone, and sends everything to the server.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and
[docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Quick start

```bash
npm i -D holt
```

Vite:

```ts
// vite.config.ts
import holt from "holt/vite";
export default { plugins: [holt()] };
```

Anything else:

```bash
npx holt
```

Then load the extension (see [packages/extension/README.md](packages/extension/README.md))
and open the side panel on your app.

## Repository

pnpm monorepo:

| path | what |
| --- | --- |
| `packages/shared` | `@holt/protocol`: types and constants shared by both halves |
| `packages/server` | `holt`: the published package (CLI, Vite plugin, core) |
| `packages/extension` | the Chrome extension (Manifest V3) |
| `examples/vite-app` | a small app to try it on |

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
