/**
 * @nitpick/protocol
 *
 * The single source of truth for how the Chrome extension talks to the
 * local nitpick server. Both sides import from here, so a change to the
 * wire format is a compile error on whichever side forgot to update.
 *
 * Design rules for this package:
 *  - Types and constants only. No runtime dependencies, no Node or DOM APIs,
 *    so it can be imported by a service worker, a side panel page, and Node.
 *  - Everything the server writes to disk is derived from these types;
 *    the extension never decides file names or paths (see SECURITY.md).
 */

export * from "./constants.js";
export * from "./entries.js";
export * from "./http.js";
