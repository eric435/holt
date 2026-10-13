# Security notes

nitpick is a local tool that writes files into your repository on request
from a browser extension. That combination deserves a short threat model.

## What we protect against

1. **A malicious web page writing into your repo.** Any page can `fetch()`
   `http://127.0.0.1:4848`. Mitigations: every request must carry a custom
   header (`x-nitpick-client`), which forces a CORS preflight for
   cross-origin pages; the preflight and the request are refused unless the
   `Origin` is a `chrome-extension://` origin (or an explicitly configured
   one). An optional shared token adds a second factor. Requests with no
   `Origin` header at all (curl, scripts) are allowed only from loopback and
   are intended for local testing.
2. **Path traversal.** The extension never supplies file names or paths. The
   server generates names from a counter and an allow-list of media types,
   and resolves every write inside the session directory, re-checking the
   resolved path stays under the output directory.
3. **Disk exhaustion.** Uploads are size-limited (`maxUploadBytes`), bodies
   are streamed to disk, and JSON bodies have a small separate limit.
4. **Exposure on the network.** The server binds to `127.0.0.1` by default.
   Setting `host` to anything else logs a loud warning.
5. **Supply chain.** The published package has zero runtime dependencies.
   `vite` is an optional peer. CI runs `npm pack --dry-run` so the
   published file list is reviewed, and `publishConfig.provenance` is on.
6. **Markdown injection.** User-provided text (notes, page titles, URLs) is
   escaped before being written into markdown so a page title cannot inject
   links or images that point elsewhere.

## What we do not protect against

- Someone with local shell access as your user. They can already edit your
  repo directly.
- Content of the screenshots. They are whatever is on your screen; the
  output directory is git-ignored by default and you decide what to commit.
