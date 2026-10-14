# Testing holt

holt has three layers of tests. Each one catches a different kind of mistake,
so a change usually needs only one of them. The rule of thumb: put logic in
a pure module and unit-test it, and leave Chrome to the two browser layers.

| Layer | Runs | Speed | Good at | Blind to |
| --- | --- | --- | --- | --- |
| Unit (vitest) | Node, no browser | ~1 s per package | logic, validation, escaping, edge cases, races in the server | anything that needs `chrome.*`, the DOM, MediaRecorder or Web Speech |
| Smoke (`smoke.mjs`) | real Chrome, no server | 1-2 min | the built extension starting cleanly, manifest and permissions, content scripts, forged messages being refused, "no server" UI | the server, and whether captures actually land on disk |
| E2E (`e2e.mjs`) | real Chrome + real server in `examples/vite-app` | a few min | the whole round trip: capture, prompt, upload, `notes.md` on disk, auto-detection, recordings | rare timing problems; anything the example app doesn't do |

## Unit tests

```sh
pnpm test             # both packages
pnpm test:coverage    # same, with a coverage table (HTML in packages/*/coverage/)
pnpm --filter @velvet-thunder/holt test src/http     # one folder
```

**Server** (`packages/server/src/**/*.test.ts`). The server is plain Node,
so it is tested in-process: `handler.test.ts` starts a real server on a free
port and sends real HTTP requests. The pure parts (markdown escaping, entry
and config validation, CORS) have table-driven tests, and `schema.test.ts`
checks that `schema.json` and the validator agree.

**Extension** (`packages/extension/src/**/*.test.ts`). These run in Node, with
no `chrome` global. Logic that decides something sits in a pure module next
to the glue that uses it, and that module is what gets tested:
`indicator-model.ts` next to `indicator.ts`, `server-resolve.ts` next to
`server.ts`, `pending-screenshot-model.ts`, `transcript-text.ts`,
`entry-view.ts`, and the message guards in `messages.ts`. A few tests go
further, using fakes:

- `shared/server.test.ts` stubs `fetch` to test the real auto-detect probe.
- `background/pending-screenshot.test.ts` replaces storage, windows and the
  API with in-memory fakes (`vi.mock`) to test the screenshot-prompt state
  machine: superseding, Save racing the window closing, and the
  worker-restart cleanup.
- `shared/speech.test.ts` runs the Web Speech wrapper against a scripted fake
  recogniser.

Write new tests the same way. If a `chrome.*` file grows an `if`, move that
decision into a pure function and test it there.

## Smoke test (real Chrome, no server)

```sh
pnpm build
pnpm --filter @holt/extension smoke     # CHROME_PATH=/path/to/chrome to override
```

This loads `dist/` into a fresh Chrome profile. It fails on any worker error
at startup, checks the registered shortcuts, injects the content scripts into
a local fixture page, and checks that forged messages from a page are
refused. CI runs it on every push.

## End-to-end test (real Chrome + real server)

```sh
pnpm --filter @holt/extension e2e
```

This builds what it needs, starts `examples/vite-app` from a temp copy (so
nothing is written into the repo), and drives the real extension through
every capture kind. It then reads `notes.md`, the PNGs and the WebMs back
from disk. It is the only test that proves auto-detection, the note prompt,
tab recording and voice notes work together. Run it before a release and
after any change to the worker, the offscreen document or the protocol.

**Running e2e in CI.** It needs the same setup as the smoke step (Chrome
at `CHROME_PATH`, which `ubuntu-latest` has) and a few minutes. Add it
after the smoke step in `.github/workflows/ci.yml`:

```yaml
      - name: End-to-end test
        run: pnpm --filter @holt/extension e2e
        env:
          CHROME_PATH: /usr/bin/google-chrome
```

If it is flaky on shared runners, run it on a schedule instead of dropping it.

## Coverage

Measured with `@vitest/coverage-v8` (statements / branches):

| Package | Before | After |
| --- | --- | --- |
| server (all of `src/`) | 90.4% / 90.6% | 93.1% / 93.7% |
| extension (pure and tested modules, see below) | 70.8% / 98.1% | 91.7% / 97.8% |

The extension's coverage leaves out files that are nothing but `chrome.*`,
DOM, canvas or MediaRecorder glue: entry points, UI rendering, the offscreen
recorders, content scripts. They can't run in Node, so they would always
show 0%. The list, and why, is in `packages/extension/vitest.config.ts`.
With them counted, the figure was 20% before this work.

Least covered on the server: `cli/index.ts` (the `holt` bin; process glue),
`log.ts` (the console logger), `adapters/standalone.ts` (signal handling).
On the extension: `settings.ts` and `shortcuts.ts`, where the uncovered lines
are the `chrome.storage` / `chrome.commands` wrappers; their pure halves
(validation, migration planning) are fully covered.

## Deliberately not unit-tested

- **`chrome.*` glue** (the worker's command handlers, side panel, toolbar
  menu, note popup). These are covered by smoke and e2e, which use the real
  APIs.
- **MediaRecorder and tab capture.** E2E records a real tab and checks that a
  valid WebM lands on disk. The voice-note path uses Chrome's fake media
  devices.
- **Web Speech.** It needs Google's speech service, so no automated test
  hears real words. The wrapper's own logic is unit-tested with a fake
  recogniser. E2E only checks that dictation doesn't break saving.
- **Pixels.** Stitching math is unit-tested (`stitch.test.ts`). E2E samples
  pixels of a real full-page capture to check the fixed header appears once.

## Worth adding next (in priority order)

1. **E2E: the side panel re-resolves on tab switch.** Two loopback tabs, one
   with holt and one without: switching between them updates the panel's
   status line and the badge.
2. **E2E: a token-protected server with auto-detect.** Auto-detect still
   finds it (the probe sees `forbidden`), captures work with the right
   token, and a wrong token shows the server's error, not a silent fallback.
3. **E2E fixture: Vite behind another backend** (pages from a plain Node
   server, assets from Vite). Pins down the documented gap: the fallback URL
   is used, and setting it to Vite's origin makes captures work.
4. **Unit: server-info coalescing** (`background/server-info.ts`): many
   refreshes during one check cause exactly one more. Same `vi.mock`
   approach as `pending-screenshot.test.ts`.
5. **Unit: `saveSettings` / `loadSettings`** against an in-memory
   `chrome.storage.local`: invalid values are refused before anything is
   written; the sync migration runs once.
6. **Unit: `background/voice-overlay.ts`**, the review handshake: box
   untouched vs edited, a navigation mid-recording (draft restored from
   `transcriptBoxes`), the one-hour commit timeout.
7. **E2E: the worker being killed** (via CDP) while a screenshot prompt is
   open and while recording: nothing is lost or written twice.
8. **Server tests on Windows** (a CI matrix entry): the path checks
   (`assertInside`, the output-dir guard) are what most likely differs.
