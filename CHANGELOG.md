# Changelog

Notable changes to holt, for users. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions are
those of the npm package `@velvet-thunder/holt` (the server), which follows
[Semantic Versioning](https://semver.org/) in its pre-1.0 form: any 0.x
release may change behavior.

The Chrome extension is versioned separately (`packages/extension/package.json`,
tags `extension-v<version>`) and has not had a Chrome Web Store release yet.
Until it does, extension changes are listed here as part of the server
release they were made in.

## [Unreleased]

### Security

- **Vite plugin: `holt.config.json` was served by the dev server.** Vite
  served the config file, including any `token` in it, at
  `/holt.config.json` (and as a module at `/holt.config.json?import`) to
  anything that could reach the dev server. The plugin now answers 404 for
  the loaded config file and for `<root>/holt.config.json`, as it already
  did for the session folders. If you kept a token in that file while using
  the Vite plugin, change it, and move it to `HOLT_TOKEN` (below).
- **Vite plugin on Windows: the output-directory guard could be bypassed.**
  Requests with Vite's `/@fs/` and `/@id/` prefixes and a drive letter
  (`/@fs/C:/proj/qa/...`), names with trailing dots or spaces, and `::$DATA`
  stream suffixes were not recognised as pointing into the output directory
  or at the config file, so Vite could serve screenshots, recordings,
  `notes.md` and `holt.config.json`. They are now refused.

### Added

- `HOLT_TOKEN` environment variable for the token. Precedence is
  `--token` or the plugin's `token` option, then `HOLT_TOKEN`, then
  `holt.config.json`. An empty `HOLT_TOKEN` counts as unset. `holt --help`
  documents it.
- A protocol version for the extension and the server: `GET /__holt/status`
  reports `protocolVersion`, and the package exports `PROTOCOL_VERSION`.
  Servers 0.0.2 and older don't report it and count as version 1. When the
  two don't match, the extension shows **Update needed**, says which side
  to update and how, and refuses to capture before you start, instead of
  failing afterwards.
- A capture of a kind the server doesn't know is refused with a message
  saying the extension is probably newer than the server and how to update
  the server.
- Extension: a **Transcribe speech** setting (on by default), in Settings,
  on the welcome tab and on the microphone permission page, with a note
  that Chrome's speech recognition sends the microphone audio to Google.
  Off, holt never starts speech recognition: voice notes keep their audio
  file instead of a transcript, tab recordings don't open the microphone,
  and the note window's dictation button is hidden.
- Extension: a welcome tab on first install, with how to start the server,
  a live check for it, your current shortcuts and the transcription switch.
- [PRIVACY.md](PRIVACY.md) (the extension's privacy policy),
  [SECURITY.md](SECURITY.md) (how to report a vulnerability) and
  [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

### Changed

- Requires Node.js 22 or newer (was 20).
- The `vite` peer dependency range is now
  `^5.4.12 || ^6.0.9 || ^7.0.0 || ^8.0.0` (was `^5.4.12 || >=6.0.9`), the
  majors CI tests. A future Vite 9 is not accepted until it is tested.
- `holt init` no longer writes a `"token": null` key, and reminds you to
  use `HOLT_TOKEN` for a token: the file is meant to be committed.
- The refusal to listen on a non-loopback `host` without a token, and the
  help for `--token`, point to `HOLT_TOKEN`.
- Vite plugin: the warning printed when Vite listens on the network now
  says that under Vite, holt only answers requests from this machine, and
  how to use the standalone server from another machine instead.

### Fixed

- Vite plugin on Vite 7 and later: holt's middlewares now run ahead of
  Vite's own. Vite 7 installs its CORS and host-check middlewares before
  plugins run, so they could handle holt's requests before holt did.

## [0.0.2] - 2026-10-14

### Changed

- Version bump only: the published package is the same as 0.0.1.

## [0.0.1] - 2026-10-14

First release on npm.

### Added

- The `holt` CLI: a local server on `127.0.0.1:4848` that writes each QA
  session to `qa/<YYYY-MM-DD-HHMMSS>/notes.md` plus its screenshots and
  recordings, with `--port`, `--host`, `--out`, `--project-name`,
  `--config` and `--token`, and `holt init` for a starter
  `holt.config.json`.
- The Vite plugin, `@velvet-thunder/holt/vite`, which mounts the same API
  on the dev server so the extension finds it on the app's own pages.
- `createHolt()` for mounting the handler in another Node server.
- Locked-down defaults: loopback only, a Host check against DNS
  rebinding, extension-only origins with a required custom header, an
  optional token, server-chosen file names, size limits, Markdown escaping
  of page titles, URLs and notes, a `.gitignore` in a newly created output
  directory, and no runtime dependencies.

[Unreleased]: https://github.com/eric435/holt/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/eric435/holt/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/eric435/holt/releases/tag/v0.0.1
