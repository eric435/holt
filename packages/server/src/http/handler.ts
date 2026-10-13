/**
 * The framework-agnostic request handler: `(req, res) => Promise<boolean>`.
 *
 * It speaks plain node:http, so the same function is mounted by the
 * standalone server and by Vite's connect middleware stack. The boolean
 * says whether the request was ours:
 *   - false: the path is not under BASE_PATH; nothing was written to `res`,
 *     and a middleware chain should call `next()`.
 *   - true:  we sent a response (success or error).
 * It never throws; every failure becomes a JSON error response.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { BASE_PATH } from "@holt/protocol";
import { applyCorsHeaders, checkClientHeaders, checkOriginAndHost, sendPreflight } from "./cors.js";
import { HttpError, sendError, sendJson } from "./errors.js";
import { routes, type RouteContext } from "./routes.js";

export type HoltHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
export type HandlerContext = RouteContext;

export function createHandler(ctx: HandlerContext): HoltHandler {
  return async (req, res) => {
    const subPath = holtSubPath(req.url);
    if (subPath === null) return false;

    try {
      // Access control first, before looking at the route or the body.
      // The order matters; see cors.ts for what each step defends against.
      const { origin } = checkOriginAndHost(req, ctx.config);
      applyCorsHeaders(res, origin);

      if (req.method === "OPTIONS") {
        sendPreflight(req, res);
        return true;
      }
      checkClientHeaders(req, ctx.config);

      const route = routes[`${req.method} ${subPath}`];
      if (!route) throw new HttpError(404, "not-found", `No route for ${req.method} ${BASE_PATH}${subPath}`);
      sendJson(res, 200, await route(req, ctx));
    } catch (err) {
      sendError(req, res, err, ctx.logger);
    }
    return true;
  };
}

/**
 * "/__holt/status?x=1" -> "/status"; anything outside BASE_PATH -> null.
 * Parsing with URL also normalizes dot segments, so "/__holt/../app" is
 * correctly treated as "/app" (not ours).
 */
function holtSubPath(rawUrl: string | undefined): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl ?? "/", "http://holt.invalid").pathname;
  } catch {
    return null;
  }
  if (pathname === BASE_PATH) return "/";
  if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length);
  return null;
}
