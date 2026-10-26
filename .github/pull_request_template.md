<!-- What does this change, and why? Link the issue if there is one. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm build` and `pnpm test` pass; for changes to the extension's worker, offscreen document or the protocol, `pnpm --filter @holt/extension e2e` too
- [ ] Tests cover the change
- [ ] Docs updated (READMEs, docs/, help text) where behavior, commands, settings or messages changed
- [ ] A `CHANGELOG.md` entry under `[Unreleased]`, if users will notice the change
- [ ] If it changes what data the extension handles or sends, or its permissions: `PRIVACY.md` and `docs/chrome-web-store.md` updated
- [ ] If it changes the protocol: `PROTOCOL_VERSION` bumped only for a breaking change (see docs/ARCHITECTURE.md)
- [ ] No new runtime dependency in `packages/server` (or the PR says why)
