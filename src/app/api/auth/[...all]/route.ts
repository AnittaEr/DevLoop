/**
 * The Better Auth catch-all route (T19).
 *
 * WHY THE SEGMENT IS `[...all]` AND NOT `[...path]`, `[[...all]]` OR A SINGLE
 * ROUTE. The Better Auth client and every auth endpoint address themselves under
 * `/api/auth/<endpoint>` — `/api/auth/sign-in/email`, `/api/auth/get-session`,
 * `/api/auth/sign-up/email`, and so on. A catch-all is the only shape that
 * matches all of them, and its NAME IS ALSO PART OF THE CONTRACT in one respect:
 * `toNextJsHandler` builds one handler for every method from the instance's own
 * router, so all sub-paths are served by this single segment whatever it is
 * called. The part that is genuinely load-bearing is that it must be a REST
 * catch-all (`[...]`, not `[[...]]`, and not a concrete segment): a concrete name
 * such as `sign-in` 404s every other endpoint silently, and an optional
 * catch-all stops matching once a request is made to `/api/auth` itself.
 *
 * NO MIDDLEWARE HERE. Route protection is explicitly out of scope for T19.
 *
 * `toNextJsHandler` returns one function per HTTP method. Next.js App Router
 * route handlers are `Request -> Response`, which is exactly what it hands back,
 * so there is nothing to wrap and no reason to add a layer that could drop one.
 */

import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";

import {
  AuthSecretMissingError,
  auth,
  requireAuthSecret,
} from "../../../../lib/auth";

/** One handler per method, all wrapping the same secret check. */
const handlers = toNextJsHandler(auth.handler);

/**
 * WHY EACH HANDLER IS WRAPPED RATHER THAN EXPORTED DIRECTLY.
 *
 * DevLoop refuses to serve auth without a real `BETTER_AUTH_SECRET`: Better Auth
 * falls back to its published default literal and only rejects that under
 * `NODE_ENV=production`, which is the mode v1 never runs in (no deployment, hard
 * rule 7). So a local `bun run dev` with no `.env` would otherwise sign cookies
 * with a key published in the library's source.
 *
 * THE CHECK IS HERE, AT REQUEST TIME, NOT AT MODULE SCOPE, because this module
 * is imported by `next build` and by `bun run test` — neither has a `.env`, and
 * neither should have to have one. Refusing per request keeps the build honest
 * instead of making a green build a misconfigured environment.
 *
 * `503` and not `500`: the server is fine and the operator's configuration is
 * not, and the two are worth distinguishing in a log. The message names the
 * VARIABLE and never the value, so it is safe to return to the client. Any other
 * error is left to propagate untouched — this is a guard, not an error handler.
 */
function guard(handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      requireAuthSecret();
    } catch (error) {
      if (error instanceof AuthSecretMissingError) {
        return NextResponse.json(
          { error: "auth_not_configured", message: error.message },
          { status: 503 },
        );
      }
      throw error;
    }

    return handler(request);
  };
}

export const GET = guard(handlers.GET);
export const POST = guard(handlers.POST);
export const PATCH = guard(handlers.PATCH);
export const PUT = guard(handlers.PUT);
export const DELETE = guard(handlers.DELETE);
