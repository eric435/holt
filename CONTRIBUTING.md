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
pnpm --filter @nitpick/extension dev     # rebuilds dist/ on change
pnpm --filter @nitpick/example-vite-app dev
```

Load `packages/extension/dist` once as an unpacked extension
(chrome://extensions → Developer mode → Load unpacked). After a rebuild, hit
the reload icon on the extension card; the side panel reloads with it.

Set the side panel's server URL to the Vite origin printed by the example
app (the plugin mounts the API on the same port), or run `npx nitpick` in
any project to use the standalone server on port 4848.

## Checks that run in CI

- `pnpm typecheck`, `pnpm build`, `pnpm test`
- `npm pack --dry-run` in `packages/server`, so the published file list is
  visible on every PR. The package must keep **zero runtime dependencies**;
  if you believe one is needed, say why in the PR.
- `pnpm --filter @nitpick/extension smoke` loads the built extension in a
  real headless Chrome and fails on any startup error.

## Where things go

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The short version: the
wire format lives in `packages/shared` and nowhere else; the server never
trusts a client-supplied path; the extension's worker registers every
listener synchronously at the top level.
