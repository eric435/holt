# Testing holt

holt has three layers of tests. Each one catches a different kind of mistake,
so a change usually needs only one of them. The rule of thumb: put logic in
a pure module and unit-test it, and leave Chrome to the two browser layers.

| Layer | Runs | Speed | Good at | Blind to |
| --- | --- | --- | --- | --- |
| Unit (vitest) | Node, no browser | ~1 s per package | logic, validation, escaping, edge cases, races in the server | anything that needs `chrome.*`, the DOM, MediaRecorder or Web Speech |
| Smoke (`smoke.mjs`) | real Chrome, no server | under a minute | the built extension starting cleanly, manifest and permissions, the welcome page, content scripts, forged messages being refused, "no server" UI | the server, and whether captures actually land on disk |
| E2E (`e2e.mjs`) | real Chrome + real server in `examples/vite-app` | about a minute (45 s on a laptop) | the whole round trip: capture, prompt, upload, `notes.md` on disk, auto-detection, recordings, voice notes | rare timing problems; anything the example app doesn't do |

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
checks that `schema.json` and the validator agree. Three files go beyond a
single module:

- `cli/cli.test.ts` runs the `holt` bin as a child process (the source,
  bundled by esbuild before the tests, so no `pnpm build` is needed):
  `--version`, `--help`, a bad flag and a bad config value exit with the
  right code and message, and SIGINT ends the active session (notes.md gets
  its footer) and exits 0. The SIGINT test is skipped on Windows, which has
  no POSIX signals.
- `adapters/vite.test.ts` tests the plugin against a stub of Vite's dev
  server, and then in a real one (whichever `vite` is installed): the API
  answers, the session folder and `holt.config.json` are not served under
  any URL, and `server.close()` writes the footer. CI runs this file
  against every Vite major in the peer range. Its preflight test guards the
  middleware order: Vite 7+ installs its own CORS middleware before plugins
  run, and the plugin moves its middlewares in front of it.
- `http/extension-contract.test.ts` is the protocol contract: it points
  the extension's own API client and entry-body builders (imported from
  `packages/extension/src` by relative path) at a real in-process server,
  and checks that `/status` passes the extension's compatibility check and
  that every entry kind and media type the extension can send is accepted
  and stored field for field. The extension modules it imports must not
  touch `chrome`; the server's Node-only typecheck enforces that.

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
at startup and checks the registered shortcuts. It checks the welcome tab
that opens on first install (exactly one; it names the server commands and
the real shortcut bindings, loads nothing remote, and its transcription
switch saves), and the side panel: it renders, migrates old settings, and
with transcription off shows "keep the audio" as forced on without
changing the stored choice. It injects the content scripts into a local
fixture page, checks that forged messages from a page are refused, and
finally simulates a click on the toolbar icon: the menu says "Not
connected", its Settings item opens the side panel, and activeTab is
granted.

That last part needs `Extensions.triggerAction`, an experimental DevTools
command. If a local Chrome doesn't have it, the script skips that part with
a warning. With `CI` set (GitHub Actions sets it) the skip is a failure, so
CI can never pass without running it.

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

The voice notes run in a second Chrome with fake media devices. Among them
is one with transcription turned off: the transcript box says so, the typed
words become the note, and the audio is kept even though "keep the audio"
is off. Both Chromes also check that the welcome tab opens on first install
(smoke checks what is on it).

CI runs it on every push and pull request, as its own job (see "What CI
runs" below). To debug a failure there, open the run's `e2e-artifacts`: on
failure the script saves the session folder it produced (notes.md, PNGs,
WebMs), Vite's output, the list of failures, and a screenshot of every page
still open. Locally, `E2E_ARTIFACTS_DIR=some/dir` does the same, and
`KEEP_TEMP=1` keeps the whole temp folder.

**Waiting in e2e and smoke.** Wait for the thing itself (`waitFor` from
`scripts/lib/chrome.mjs`: the entry is in notes.md, the box is on the page,
the target exists), never for a fixed time: a CI runner can be several
times slower than a laptop. A fixed `sleep` is right in only two cases,
each with a comment saying which: proving that something does *not*
happen within a window (no entry while a prompt is open, nothing saved
during review), and giving a recording its length so the file checked on
disk has media in it.

## What CI runs

`.github/workflows/ci.yml`, on every push to `main` and every pull request:

| Job | Runs on | What |
| --- | --- | --- |
| `verify` | Ubuntu, Node 22 and 24 | `pnpm typecheck`, `pnpm build`, `pnpm test`, `check-pack`, the example app's typecheck and build, the smoke test |
| `server-os` | Windows and macOS, Node 22 | typecheck, build and unit tests of `packages/server` (file writing and the Windows path rules on a real file system) |
| `vite-compat` | Ubuntu, Node 22 | the server's typecheck and `vite.test.ts` against Vite 5.4.12, 6.0.9, 7.0.0, 8.0.0 and the latest 5, 6, 7 and 8 |
| `e2e` | Ubuntu, Node 22 | the end-to-end test, with artifacts on failure |

Node 22 is the floor (`engines` in both package.json files); 24 is the
current release line. The extension and browser tests run on Linux only.
The peer range for `vite` in `packages/server/package.json` lists only
majors that `vite-compat` tests; supporting a new major means adding it to
both.

## Coverage

Measured with `@vitest/coverage-v8` (`pnpm test:coverage`), statements /
branches: the server (all of `src/`) about 93% / 94%; the extension (pure
and tested modules, see below) about 92% / 98%.

The extension's coverage leaves out files that are nothing but `chrome.*`,
DOM, canvas or MediaRecorder glue: entry points, UI rendering, the offscreen
recorders, content scripts. They can't run in Node, so they would always
show 0% and only hide the number that matters. The list, and why, is in
`packages/extension/vitest.config.ts`; smoke and e2e run those files
instead.

Least covered on the server: `cli/index.ts` (the `holt` bin) shows 0%, but
`cli.test.ts` runs it as a child process, which v8 coverage in the test
process cannot see. Then `log.ts` (the console logger) and
`adapters/standalone.ts` (the signal handlers, also run by `cli.test.ts`).
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
