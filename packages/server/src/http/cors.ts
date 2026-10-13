/**
 * Who may talk to the server. This is the heart of docs/SECURITY.md.
 *
 * The problem: any web page you visit can `fetch("http://127.0.0.1:4848/...")`.
 * Browsers send such cross-origin requests and only enforce CORS on reading
 * the *response*, so "writes" would succeed unless we refuse them ourselves.
 *
 * The checks, in the order the handler applies them:
 *
 * 0. A request from another machine needs a token. Host and Origin are
 *    just headers: a browser sets them honestly, but any other client can
 *    forge them. The socket's remote address cannot be forged, so without a
 *    token, only this machine may talk to us. (With a token, step 5 checks it.)
 *
 * 1. Host header must name a loopback host (or the configured host).
 *    Defends against DNS rebinding: evil.example re-resolving to 127.0.0.1
 *    makes the attacker page *same-origin* with us, so no preflight and no
 *    Origin header on GETs. Its requests still say `Host: evil.example`.
 *
 * 2. Origin must be a `chrome-extension://` origin (restricted to
 *    `allowedExtensionIds` if set) or listed in `allowedOrigins`.
 *    No Origin header at all is accepted only from a non-browser client on
 *    a loopback socket (curl, scripts), for local testing, or with
 *    `Sec-Fetch-Site: none` (the extension's own GETs; see hasFetchMetadata).
 *    Page-initiated requests are told apart by their `Sec-Fetch-*` headers,
 *    which browsers attach to every request and pages cannot remove. That
 *    matters in Vite mode: a script on the app under test is same-origin
 *    with /__nitpick, and browsers omit Origin on same-origin GETs, so
 *    without this check it could read /status.
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
import { EXTENSION_ID } from "../config/validate.js";
import { HttpError } from "./errors.js";


const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = ["content-type", CLIENT_HEADER, TOKEN_HEADER, KIND_HEADER].join(", ");

const EXTENSION_SCHEME = "chrome-extension://";

/**
 * A chrome-extension origin is allowed if its ID is well-formed and, when
 * `allowedExtensionIds` is set, listed there. Web origins must be listed in
 * `allowedOrigins` exactly.
 */
export function isAllowedOrigin(
  origin: string,
  { allowedOrigins, allowedExtensionIds }: Pick<ResolvedConfig, "allowedOrigins" | "allowedExtensionIds">,
): boolean {
  if (origin.startsWith(EXTENSION_SCHEME)) {
    const id = origin.slice(EXTENSION_SCHEME.length);
    if (!EXTENSION_ID.test(id)) return false;
    return allowedExtensionIds.length === 0 || allowedExtensionIds.includes(id);
  }
  return allowedOrigins.includes(origin);
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
 * Steps 0 to 2. Returns the origin to echo in CORS headers (null for
 * same-machine requests without an Origin). Throws 403 otherwise.
 */
export function checkOriginAndHost(req: IncomingMessage, config: ResolvedConfig): { origin: string | null } {
  const local = isLoopbackAddress(req.socket.remoteAddress);
  if (!local && config.token === null) {
    throw new HttpError(
      403,
      "forbidden",
      `Requests from other machines are refused unless a token is configured`,
    );
  }
  if (!isAllowedHost(req.headers.host, config.host)) {
    throw new HttpError(403, "forbidden", "Host header is not a loopback host");
  }
  const origin = req.headers.origin;
  if (origin === undefined) {
    if (hasFetchMetadata(req)) {
      throw new HttpError(403, "forbidden", "Browser requests must come from the nitpick extension");
    }
    if (local) return { origin: null };
    throw new HttpError(403, "forbidden", "Requests without an Origin header are only accepted from this machine");
  }
  if (!isAllowedOrigin(origin, config)) {
    throw new HttpError(403, "forbidden", `Origin ${origin} is not allowed`);
  }
  return { origin };
}

/**
 * True if the request carries `Sec-Fetch-*` headers saying it came from a
 * web page. `Sec-Fetch-Site: none` is the exception: Chrome uses it only
 * for requests no page initiated, i.e. the user typing a URL (which cannot
 * add our custom header) or a privileged context. That includes the nitpick
 * extension itself: Chrome omits Origin on an extension's GET to a host it
 * has permission for and sends `Sec-Fetch-Site: none` instead. Pages
 * cannot set or change Sec-Fetch-* headers.
 */
function hasFetchMetadata(req: IncomingMessage): boolean {
  if (req.headers["sec-fetch-site"] === "none") return false;
  return Object.keys(req.headers).some((name) => name.startsWith("sec-fetch-"));
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
