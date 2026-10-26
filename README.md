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

You click through your app and capture from holt's toolbar menu or with
keyboard shortcuts. Every capture becomes one line in `notes.md`: what you
typed or said about it, a link to the screenshot or recording, and the page
it was taken on. Hand the folder to a teammate, paste it into an issue, or
point your coding agent at it.

## How it works

Two pieces:

1. **A local server**, the npm package
   [`@velvet-thunder/holt`](packages/server/README.md), that receives
   captures and writes the files. Run it standalone, or add its Vite plugin
   so it rides along with your dev server.
2. **A Chrome extension** that takes screenshots, records the tab and the
   microphone, and sends everything to that server. Nothing goes anywhere
   else, except the audio Chrome's speech recognition sends to Google while
   it transcribes, which you can turn off (see [PRIVACY.md](PRIVACY.md)).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and
[docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Install

**The server**, in your project (Node.js 22 or newer):

```bash
npm i -D @velvet-thunder/holt
```

With Vite, add the plugin:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import holt from "@velvet-thunder/holt/vite";

export default defineConfig({ plugins: [holt()] });
```

With anything else, start it next to your dev server:

```bash
npx holt
```

To try it without installing, run `npx @velvet-thunder/holt` instead (a
plain `npx holt` outside a project that has the package installs an
unrelated package called `holt`).

**The extension**: install holt from the Chrome Web Store <!-- TODO: store URL: link "Chrome Web Store" and delete the parenthesis --> (not listed yet; until it is, [build it from source](CONTRIBUTING.md#building-the-extension-from-source)).
Pin its icon to the toolbar (puzzle-piece menu → pin): clicking it opens
holt's menu, and it shows when something is recording.

There is usually nothing to configure:

- **Vite plugin:** the extension finds holt by itself on every page your
  dev server serves (it asks the page's origin for `/__holt/status`, only
  on `http://localhost` and `http://127.0.0.1`).
- **`npx holt`:** the extension's fallback server URL is
  `http://127.0.0.1:4848`, which is where `npx holt` listens by default.

Two setups need a URL in the extension's settings (holt's menu →
**Settings** → Server): a standalone server on another port, and Vite
behind another backend (Rails, Laravel, Django, ...) whose pages come from
the backend's origin rather than Vite's. Set the fallback URL to the server
holt runs on, e.g. `http://localhost:5173`; the Vite plugin's startup output
prints it.

More: [server options and config](packages/server/README.md),
[extension shortcuts, settings and permissions](packages/extension/README.md).

## What you get

One folder per session in `qa/` (the folder name is the local time the
session started), with a `notes.md` like this:

```markdown
# QA session 2026-10-13 07:52

- Started: 2026-10-13T07:52:00-07:00
- Project: /Users/you/app

---

- Submit button overlaps the footer on narrow widths. ![Screenshot 1](./001-screenshot.png) Page: [Checkout – My App](http://localhost:5173/checkout)
- Here I add two items and the total doesn't update. [Recording 2](./002-recording.webm) (0:42) Page: [Cart – My App](http://localhost:5173/cart)
- Coupon field accepts whitespace-only input. Page: [Checkout – My App](http://localhost:5173/checkout)
- The quantity stepper jumps by two when I click fast. Page: [Cart – My App](http://localhost:5173/cart)

---

_Session ended at 2026-10-13T08:10:00-07:00 (4 entries)._
```

That is a screenshot with a typed note, a tab recording with its narration,
a typed note, and a voice note (by default a voice note keeps only your
words; it can keep the audio too). Entries have no per-entry time or
heading; the file names number them. The full format is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#markdown-format).

holt puts a `.gitignore` in the output folder when it creates it, so
sessions are not committed unless you delete that file.

## Using it with a coding agent

`notes.md` is written to be read by people and agents alike. Point the
agent at the session folder, for example:

```text
Read qa/2026-10-13-075200/notes.md. Each list item is one problem I found
while clicking through the app: what I said, a screenshot or recording,
and the page it happened on. Open the screenshots it links. Fix the
problems one at a time, and tell me which ones you could not reproduce.
```

An agent that reads images can look at the PNG screenshots. Recordings are
WebM video, which most agents can't watch, so for those the narration in
the note is what the agent gets.

Page titles and URLs in `notes.md` come from the pages you captured, so
treat them as untrusted input to the agent (see
[docs/SECURITY.md](docs/SECURITY.md#what-this-does-not-protect-against)).

## Browser support

- **Chrome 127 or newer** on the desktop (the manifest's
  `minimum_chrome_version`).
- **Other Chromium browsers** (Edge, Brave, Arc, ...) are untested. The
  extension uses `chrome.sidePanel`, `chrome.offscreen` and
  `chrome.tabCapture`, and transcribes with `webkitSpeechRecognition`,
  which in Chrome is Google's online speech service. A browser without
  that service (Brave and Arc may not have it) can still take screenshots
  and recordings, but transcription fails with a message and voice notes
  keep their audio instead; turn off **Transcribe speech** in the settings
  to skip it.
- **Node.js 22 or newer** for the server.

## Troubleshooting

[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) covers the red **!** on
the toolbar icon, "Update needed", the microphone, transcription, a busy
port, Vite behind another backend, missing shortcuts, and where captures
go.

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

[CONTRIBUTING.md](CONTRIBUTING.md) has the development setup and how
releases work, [CHANGELOG.md](CHANGELOG.md) what changed. Report
vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes.

## License

MIT
