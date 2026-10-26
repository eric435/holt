/**
 * Can this extension work with the holt server that answered? (pure,
 * unit-tested; the protocol contract test runs it against the server's
 * real /status too.)
 *
 * The extension auto-updates from the Chrome Web Store, but every project
 * pins its own `@velvet-thunder/holt`, so the two are often from different
 * releases. They agree on PROTOCOL_VERSION (@holt/protocol constants.ts,
 * which also says when it is bumped: only for breaking changes), and the
 * server reports its own as `protocolVersion` in GET /status:
 *
 *   missing                -> 1 (servers 0.0.2 and older, which speak
 *                             what protocol 1 is)
 *   equal to ours          -> compatible
 *   lower than ours        -> the server is too old: update it (npm / npx)
 *   higher than ours       -> this extension is too old: update it
 *
 * Anything that is not a positive integer counts as missing: no holt
 * server sends that, and treating it as 1 means a confused server is
 * talked to as before (its own errors still show) rather than blamed on a
 * version.
 *
 * An incompatible server is treated like a server with a problem, the way
 * "not connected" and "wrong token" are: `ok: false` in `serverInfo` (the
 * toolbar's "!" and the menu's problem line, background/server-info.ts),
 * "down" in the panel's status line, red on the welcome page, and every
 * capture refuses with `message` before it starts (shared/server.ts
 * `assertCompatible`), instead of failing with a 400 after the user's work.
 * (A server that doesn't answer at all is still left to the capture's own
 * request, as before: it may be started in the meantime.)
 *
 * This module imports nothing that touches chrome.*, so the contract test
 * (packages/server/src/http/extension-contract.test.ts) can run it in Node.
 */

import { PROTOCOL_VERSION } from "@holt/protocol";
import { displayHost, projectName, type StatusLike } from "./server-label.js";

/** What a status without `protocolVersion` speaks (see the header). */
export const LEGACY_PROTOCOL_VERSION = 1;

/** The command that updates the server, as a project installs it (devDependency) or runs it ad hoc (npx). */
export const SERVER_UPDATE_HINT = "npm i -D @velvet-thunder/holt@latest (or run npx @velvet-thunder/holt@latest)";

export type ProtocolCompatibility =
  | { ok: true; serverProtocol: number }
  | {
      ok: false;
      /** Which side has to be updated. */
      problem: "server-too-old" | "extension-too-old";
      serverProtocol: number;
      /** What to tell the user, naming the server's project (or host) and what to do. */
      message: string;
    };

/** The protocol version a /status body says its server speaks. */
export function serverProtocolVersion(status: StatusLike): number {
  const v = status.protocolVersion;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : LEGACY_PROTOCOL_VERSION;
}

/**
 * Compare the server's protocol (from its /status body) with ours.
 * `serverUrl` only names the server in the message when it has no project
 * name; `extensionProtocol` is a parameter for tests.
 */
export function protocolCompatibility(
  status: StatusLike,
  serverUrl: string,
  extensionProtocol: number = PROTOCOL_VERSION,
): ProtocolCompatibility {
  const serverProtocol = serverProtocolVersion(status);
  if (serverProtocol === extensionProtocol) return { ok: true, serverProtocol };
  const project = projectName(status);
  const where = project ? `in ${project}` : `at ${displayHost(serverUrl)}`;
  if (serverProtocol < extensionProtocol) {
    return {
      ok: false,
      problem: "server-too-old",
      serverProtocol,
      message: `The holt server ${where} is too old for this extension. Update it: ${SERVER_UPDATE_HINT}, then restart it.`,
    };
  }
  return {
    ok: false,
    problem: "extension-too-old",
    serverProtocol,
    message:
      `This holt extension is older than the holt server ${where}. ` +
      "Update it at chrome://extensions (Developer mode, then Update) or wait for Chrome to update it.",
  };
}
