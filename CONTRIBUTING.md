# Contributing

## Setup

```bash
pnpm install
pnpm build        # all packages
pnpm test         # all packages
pnpm typecheck
```

Node 22+ and pnpm 10 (`corepack enable` picks the version from package.json).

## Building the extension from source

Until holt is in the Chrome Web Store, and for working on it, load your own
build:

1. Build it: `pnpm install`, then `pnpm --filter @holt/extension build`
   (writes `packages/extension/dist` and checks the manifest).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick `packages/extension/dist`.
4. Pin the holt icon to the toolbar (puzzle-piece menu → pin). Clicking it
   opens holt's menu, and it is the recording indicator.

After a rebuild, click the reload arrow on holt's card in
`chrome://extensions`; the side panel reloads with it. The welcome tab
opens only when holt is first installed in a profile, not when you reload.

An unpacked build gets its own extension ID (not the store's), which
matters if you pin `allowedExtensionIds` in a server config (see
[the server README](packages/server/README.md#configuration)). To update
it, pull, rebuild and reload. The extension README has the
[build commands and outputs](packages/extension/README.md#building-from-source).

## Day-to-day

Two terminals:

```bash
pnpm --filter @holt/extension dev     # rebuilds dist/ on change
pnpm --filter @holt/example-vite-app dev
```

Load `packages/extension/dist` once as an unpacked extension (see
[above](#building-the-extension-from-source)). After a rebuild, hit the
reload icon on the extension card; the side panel reloads with it.

Nothing to configure for the example app: the plugin mounts the API on the
Vite origin and the extension auto-detects it on that page.

Every other page falls back to the standalone server on port 4848. To run
that one from this repo against some project:

```bash
pnpm start:server ../some-project        # builds, then runs the CLI in that dir
pnpm start:server ../some-project --port 4949
```

The server writes sessions into the directory it runs from, which is why the
script takes a project directory. Note that `pnpm dev:server` does *not*
start a server; it is `tsup --watch` and only rebuilds `packages/server/dist`
while you edit server code (pair it with `start:server`, or restart the
latter, to pick up changes). In a project that has the package installed,
`npx holt` is the equivalent of `start:server`; without an install use
`npx @velvet-thunder/holt` (plain `npx holt` would fetch the unrelated `holt`
package from the registry).

## Checks that run in CI

On every push to `main` and every pull request
([ci.yml](.github/workflows/ci.yml); the full table is in
[docs/TESTING.md](docs/TESTING.md#what-ci-runs)):

- `pnpm typecheck`, `pnpm build`, `pnpm test` on Linux with Node 22 and 24.
- `pnpm --filter @velvet-thunder/holt check-pack` builds the tarball the
  Release workflow publishes (`scripts/pack.mjs`, which also drops
  `devDependencies` and `scripts` from the published package.json) and
  fails on any file outside an allow-list (`dist/`, `schema.json`,
  `README.md`, `LICENSE`, `package.json`), on a missing required file, on
  any runtime dependency, or on a `workspace:` specifier. The package must keep **zero runtime dependencies**; if you
  believe one is needed, say why in the PR.
- The example app (`examples/vite-app`) is typechecked and built.
- `pnpm --filter @holt/extension smoke` loads the built extension in a
  real headless Chrome and fails on any startup error.
- The server's typecheck, build and unit tests also run on Windows and
  macOS.
- `vite.test.ts` runs against the lowest and the latest release of every
  Vite major in the server's peer range.
- `pnpm --filter @holt/extension e2e` (real Chrome and a real server, about
  a minute) runs as its own job. On failure the run has an
  `e2e-artifacts` download with the session folder, Vite's output and
  screenshots.

Running e2e locally is still worth it before you push changes to the
worker, the offscreen document or the protocol: it is the only test of the
real capture flows, and a local failure is quicker to debug.

## Releasing

Two things are released, independently: the server, `packages/server`
(`@velvet-thunder/holt`), to npm, described here; and the extension to the
Chrome Web Store, described in the next section. Server releases are
published by [the Release workflow](.github/workflows/release.yml), never
from a laptop: the package sets `publishConfig.provenance`, which needs the
OIDC identity of a CI run, so a local `npm publish` fails.

To release, bump `version` in `packages/server/package.json` (and nothing
else; the server reads its version from there), move the `Unreleased`
notes in [CHANGELOG.md](CHANGELOG.md) under a heading for that version, and
merge to `main`. On
every push to `main`, the workflow checks whether npm already has that
version. If not, it runs `pnpm typecheck`, `pnpm build`, `pnpm test` and
`check-pack`, publishes with provenance, and tags the commit `v<version>`.
A prerelease version (`0.2.0-beta.1`) is published under the `next`
dist-tag instead of `latest`. The workflow can also be started by hand from
the Actions tab (`workflow_dispatch`).

The workflow authenticates with npm trusted publishing: on npmjs.com, the
package's Settings → Trusted Publisher names GitHub Actions, `eric435/holt`,
workflow `release.yml`. No npm token is stored in the repository.

The very first publish of a new package can't use trusted publishing yet,
so for that one the workflow uses an `NPM_TOKEN` repository secret if it
exists: a **granular** npm token with read and write permission for the
`@velvet-thunder` scope only, "Bypass 2FA" ticked, and a short expiry. Once
the package exists, set up the trusted publisher, delete the secret, revoke
the token, and set the package's Publishing access to "Require two-factor
authentication and disallow tokens".

## Releasing the extension

The extension is uploaded to the Chrome Web Store by hand. CI builds and
checks the zip; a person uploads it in the developer dashboard.

1. **Bump the version** in `packages/extension/package.json`. That is the
   only place it lives: `build.mjs` writes it into `dist/manifest.json`, and
   `packages/extension/manifest.json` has no `version` on purpose. Chrome
   versions are one to four dot-separated integers (no `-beta.1`;
   `check-manifest` fails on one), and every upload must be higher than the
   version already in the store. Note the extension's changes in
   [CHANGELOG.md](CHANGELOG.md) too. Merge to `main`.
2. **Build the zip.** In the Actions tab, run
   [Extension release](.github/workflows/extension-release.yml) on `main`.
   It fails if the tag `extension-v<version>` already exists, runs
   typecheck, build, tests, `pnpm --filter @holt/extension package` and the
   smoke test (on the `dist/` it just zipped), uploads the zip as a run
   artifact, and tags the commit `extension-v<version>`. Tick `dry_run` to
   try it from any branch without tagging.

   To build the same zip locally: `pnpm package:extension` (an alias for
   `pnpm --filter @holt/extension package`) writes
   `packages/extension/release/holt-extension-<version>.zip`, which is
   gitignored. It leaves out source maps (and the `sourceMappingURL`
   comments that point at them), refuses a `0.0.0` version, and refuses a
   version whose `extension-v<version>` tag exists locally (`git fetch
   --tags` first). The zip is reproducible: the same `dist/` and Node
   version give the same bytes, and the script prints its SHA-256. Prefer
   the workflow's zip for real uploads; if you do upload a local one, tag
   the commit it was built from yourself.
3. **Download it** from the workflow run's summary page. GitHub wraps every
   artifact in a zip, so unzip the download once and keep the inner
   `holt-extension-<version>.zip`.
4. **Upload it** in the
   [developer dashboard](https://chrome.google.com/webstore/devconsole):
   the item → Package → Upload new package, then check the listing and
   Submit for review.

**First submission.** Everything the dashboard asks for besides the zip
(store listing text, single-purpose statement, a justification for each
permission and host permission, the data-usage answers, screenshots) is in
[docs/chrome-web-store.md](docs/chrome-web-store.md); the privacy policy
URL is [PRIVACY.md](PRIVACY.md). Before submitting:

- the publisher account is registered and verified, with 2-step
  verification on;
- the zip's `manifest.json` has the version you expect and only the
  permissions `check-manifest` allows;
- every permission and host permission in the manifest has a justification
  from docs/chrome-web-store.md in the Privacy tab, and the data-usage
  answers and certifications match PRIVACY.md;
- the listing has its screenshots and its store icon (upload
  `packages/extension/public/icons/icon-128.png`), and the privacy policy
  URL opens;
- visibility is what you intend (Unlisted is a reasonable first step).

**Review.** Expect a wait from a few days to a few weeks for the first
submission (`tabCapture`, `scripting` and host permissions draw a closer
look), and usually less for updates. Once approved, Chrome auto-updates
installed copies within hours. If the review is rejected, the email says
why: fix it, bump the version (the rejected one already has its tag) and
run the workflow again.

**Automating uploads later.** The workflow does not talk to the Web Store
API: the first submission has to go through the dashboard, and the API
needs OAuth credentials for the publisher account. The end of
`extension-release.yml` has a commented-out step using
`chrome-webstore-upload-cli`, with the secrets it needs and how to enable
it.

**How extension and server versions relate.** They are independent: the
extension is `packages/extension/package.json` and tags
`extension-v<version>`; the server is `packages/server/package.json` and
tags `v<version>`. A server is updated whenever a user updates their npm
dependency, and the extension whenever the store approves an update, so any
recent extension can meet any recent server. The protocol between them has
its own version, `PROTOCOL_VERSION` in `packages/shared`: bump it only for
breaking changes (the rule is written next to the constant and in
docs/ARCHITECTURE.md), and the extension then tells users which side to
update. Prefer additive changes, and release the server first when both
change.

## Where things go

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The short version: the
wire format lives in `packages/shared` and nowhere else; the server never
trusts a client-supplied path; the extension's worker registers every
listener synchronously at the top level.
