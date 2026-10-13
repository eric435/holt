/**
 * Who may talk to the server. This is the heart of docs/SECURITY.md.
 *
 * The problem: any web page you visit can `fetch("http://127.0.0.1:4848/...")`.
 * Browsers send such cross-origin requests and only enforce CORS on reading
 * the *response*, so "writes" would succeed unless we refuse them ourselves.
 *
 * The checks, in the order the handler applies them:
 *
 * 1. Host header must name a loopback host (or the configured host).
 *    Defends against DNS rebinding: evil.example re-resolving to 127.0.0.1
 *    makes the attacker page *same-origin* with us, so no preflight and no
 *    Origin header on GETs. Its requests still say `Host: evil.example`.
 *
 * 2. Origin must be a `chrome-extension://` origin or listed in
 *    `allowedOrigins`. No Origin header at all (curl, scripts) is accepted
 *    only from a loopback socket, for local testing.
 *
 * 3. OPTIONS preflights are answered here, only for allowed origins.
 *
 * 4. Every non-preflight request must carry `x-nitpick-client: extension`.
 *    A custom header can't be sent cross-origin without a preflight, and
 *    the preflight fails for non-allowed origins (step 2), so a page cannot
 *    use a "simple" (unpreflighted) request to sneak a write through.
 *
 * 5. If a token is configured, `x-nitpick-token` must match it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, KIND_HEADER, TOKEN_HEADER } from "@nitpick/protocol";
import type { ResolvedConfig } from "../config/types.js";
import { HttpError } from "./errors.js";

/** Chrome extension IDs are 32 characters from a to p. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = ["content-type", CLIENT_HEADER, TOKEN_HEADER, KIND_HEADER].join(", ");

export function isAllowedOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
  return EXTENSION_ORIGIN.test(origin) || allowedOrigins.includes(origin);
}

/** True for a socket address on this machine: 127.0.0.0/8 or ::1 (also IPv4-mapped). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** True for a host name or IP that always means "this machine". */
export function isLoopbackHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return h === "localhost" || h.endsWith(".localhost") || isLoopbackAddress(h);
}

/** Bind addresses meaning "every interface". Never a valid Host header value. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/**
 * Check the Host header (step 1). Accepts loopback names on any port, plus
 * the exact host the server was configured to bind to (for someone who
 * deliberately set e.g. `"host": "192.168.1.10"`).
 */
export function isAllowedHost(hostHeader: string | undefined, configuredHost: string): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    // Let the URL parser split off the port and normalize the name.
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  if (isLoopbackHostname(hostname)) return true;
  const configured = normalizeHostname(configuredHost);
  return !WILDCARD_HOSTS.has(configured) && normalizeHostname(hostname) === configured;
}

/** Lowercase and strip IPv6 brackets: "[::1]" -> "::1". */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/**
 * Steps 1 and 2. Returns the origin to echo in CORS headers (null for
 * same-machine requests without an Origin). Throws 403 otherwise.
 */
export function checkOriginAndHost(req: IncomingMessage, config: ResolvedConfig): { origin: string | null } {
  if (!isAllowedHost(req.headers.host, config.host)) {
    throw new HttpError(403, "forbidden", "Host header is not a loopback host");
  }
  const origin = req.headers.origin;
  if (origin === undefined) {
    if (isLoopbackAddress(req.socket.remoteAddress)) return { origin: null };
    throw new HttpError(403, "forbidden", "Requests without an Origin header are only accepted from this machine");
  }
  if (!isAllowedOrigin(origin, config.allowedOrigins)) {
    throw new HttpError(403, "forbidden", `Origin ${origin} is not allowed`);
  }
  return { origin };
}

/**
 * CORS response headers for an allowed origin. We echo the exact origin
 * (never `*`) so the browser lets that one extension read the response.
 */
export function applyCorsHeaders(res: ServerResponse, origin: string | null): void {
  res.setHeader("Vary", "Origin");
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
}

/** Step 3: answer a preflight for an origin that already passed step 2. */
export function sendPreflight(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 204;
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  res.setHeader("Access-Control-Max-Age", "600");
  // Chrome's Private Network Access asks before letting a page reach
  // loopback; answer yes, but only for origins we already allowed.
  if (req.headers["access-control-request-private-network"] === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  res.end();
}

/** Steps 4 and 5. Throws 403 if the client header or token is wrong. */
export function checkClientHeaders(req: IncomingMessage, config: ResolvedConfig): void {
  if (req.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) {
    throw new HttpError(403, "forbidden", `Missing "${CLIENT_HEADER}: ${CLIENT_HEADER_VALUE}" header`);
  }
  if (config.token !== null) {
    const given = req.headers[TOKEN_HEADER];
    if (typeof given !== "string" || !tokensMatch(given, config.token)) {
      throw new HttpError(403, "forbidden", `Missing or wrong "${TOKEN_HEADER}" header`);
    }
  }
}

/**
 * Constant-time comparison, so response timing does not reveal how much of
 * a guessed token was right. Hashing first gives equal-length inputs, which
 * timingSafeEqual requires, without leaking the real token's length.
 */
function tokensMatch(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
