# Contributing

## Setup

```bash
pnpm install
pnpm build        # all packages
pnpm test         # all packages
pnpm typecheck
```

Node 20+ and pnpm 10 (`corepack enable` picks the version from package.json).

## Day-to-day

Two terminals:

```bash
pnpm --filter @holt/extension dev     # rebuilds dist/ on change
pnpm --filter @holt/example-vite-app dev
```

Load `packages/extension/dist` once as an unpacked extension
(chrome://extensions → Developer mode → Load unpacked). After a rebuild, hit
the reload icon on the extension card; the side panel reloads with it.

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

- `pnpm typecheck`, `pnpm build`, `pnpm test`
- `npm pack --dry-run` in `packages/server`, so the published file list is
  visible on every PR. The package must keep **zero runtime dependencies**;
  if you believe one is needed, say why in the PR.
- `pnpm --filter @holt/extension smoke` loads the built extension in a
  real headless Chrome and fails on any startup error.

## Releasing

Only `packages/server` (`@velvet-thunder/holt`) is published. Releases are
published by [the Release workflow](.github/workflows/release.yml), never
from a laptop: the package sets `publishConfig.provenance`, which needs the
OIDC identity of a CI run, so a local `npm publish` fails.

To release, bump `version` in `packages/server/package.json` (and nothing
else; the server reads its version from there) and merge to `main`. On
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

## Where things go

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The short version: the
wire format lives in `packages/shared` and nowhere else; the server never
trusts a client-supplied path; the extension's worker registers every
listener synchronously at the top level.
