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
import {
  ALLOW_SIGN_UP_ENV_VAR,
  signUpAllowed,
} from "../../../../app/auth/sign-up-flag";

/** One handler per method, all wrapping the same secret check. */
const handlers = toNextJsHandler(auth.handler);

/** The Better Auth path segment that CREATES an account. */
const SIGN_UP_PATH = "/sign-up/email";

/**
 * Whether this request is an account-CREATION request.
 *
 * MATCHED ON THE PATH SUFFIX, not on an exact equality. The handler is mounted
 * under a BASE PATH, so it sees `/api/auth/sign-up/email` rather than
 * `/sign-up/email` — MEASURED, not reasoned: an exact comparison against the
 * bare path let every request reach Better Auth and answer `500` on the missing
 * database, which is how the first version of this guard silently did nothing.
 *
 * Matched on the PATH rather than on the request body or the referring page,
 * because the body is the thing a caller controls and the page is not: the form
 * being hidden proves nothing about the endpoint being closed.
 */
function isSignUpRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname.endsWith(SIGN_UP_PATH);
}

/**
 * Refuse account CREATION unless `DEVLOOP_ALLOW_SIGN_UP=1`.
 *
 * WHY THIS IS HERE AND NOT ONLY IN THE FORM. MEASURED over real HTTP against
 * the built server with `DEVLOOP_ALLOW_SIGN_UP` UNSET: a direct
 * `POST /api/auth/sign-up/email` answered **200 OK**, created a user row and
 * returned `set-cookie: better-auth.session_token=…`. Hiding the form gated the
 * UI and left the endpoint wide open, which is c2's exact prohibition — "must
 * NOT be reachable in a way that lets a second account be created" — and a form
 * check could never have caught it. A unit test asserting the HTML lacks the
 * word "Sign up" would pass against exactly this defect.
 *
 * `403` and not `404`: the server understood the request and refuses it on
 * policy. The body names the VARIABLE that enables it and never its value, so
 * it is safe to return — the same rule the secret guard follows. It is a
 * deliberate refusal, NOT a misconfiguration, so it must not be confused with
 * the `503 auth_not_configured` above or with "signed out".
 *
 * This gates ACCOUNT CREATION ONLY. No environment variable anywhere disables
 * the session guard, and none disables sign-in.
 */
function guardSignUp(handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    if (isSignUpRequest(request) && !signUpAllowed()) {
      return NextResponse.json(
        {
          error: "sign_up_not_allowed",
          message:
            "Account creation is disabled. DevLoop is single-user and local " +
            `(c2); set ${ALLOW_SIGN_UP_ENV_VAR}=1 to create the local account.`,
        },
        { status: 403 },
      );
    }

    return handler(request);
  };
}

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
 *
 * ORDER MATTERS AND IS MEASURED. The SECRET check runs first, so a server with
 * no secret reports `503 auth_not_configured` about everything rather than
 * answering a partially-configured sign-up with a policy `403` that would read
 * as "sign-up is off here" on a server that cannot authenticate anyone at all.
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

    return guardSignUp(handler)(request);
  };
}

export const GET = guard(handlers.GET);
export const POST = guard(handlers.POST);
export const PATCH = guard(handlers.PATCH);
export const PUT = guard(handlers.PUT);
export const DELETE = guard(handlers.DELETE);
