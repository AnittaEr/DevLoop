/**
 * Session helper (T19).
 *
 * A thin, typed wrapper over Better Auth's `auth.api.getSession` for server
 * components and route handlers. It exists so a caller reads one function instead
 * of remembering to forward request headers — the single most common way a
 * server-side session check silently reports "signed out" for a user who is
 * actually signed in.
 *
 * WHAT "NO PROTECTION LOGIC HERE" NOW MEANS. It still means no DECISION logic:
 * what to do about a missing session (redirect, 401, render a login link) belongs
 * to the routes that consume this, and route protection is a later card. It no
 * longer means "no checks": `getSession()` refuses to answer at all when
 * `BETTER_AUTH_SECRET` is missing or default, because that is the one question
 * whose answer this module cannot give safely. See `requireConfiguredSession`.
 *
 * WHY THE REFUSAL BELONGS HERE AND NOT ONLY IN THE ROUTE (QA round 3, D5).
 * `requireAuthSecret()` had exactly one production caller, the `[...all]` route
 * handlers. This module is the SECOND consumer of the same module-scope instance,
 * and that instance deliberately does not pass `secret` — Better Auth resolves
 * `options.secret || env.BETTER_AUTH_SECRET` and falls back to its published
 * literal when neither is set (`dist/context/create-context.mjs`), rejecting that
 * literal only under `NODE_ENV=production`, the mode v1 never runs in (hard rule
 * 7: no deployment). So with no `.env` — the state a local run is in by default,
 * and the exact state `cp .env.example .env` produces — the route refused while
 * this helper did not. QA measured the consequence against a real Postgres: a
 * session cookie forged with the library's PUBLISHED DEFAULT key, built with the
 * library's own `serializeSignedCookie`, was ACCEPTED and `getSession()` reported
 * the forged session's user. The route guard covered `/api/auth/*` and nothing
 * else, and this is the function a later card will ask "who is signed in?" of.
 *
 * WHY IT THROWS RATHER THAN RETURNING `null`. `null` means "no session", which is
 * a normal, expected answer. Returning it for "no SECRET configured" would be the
 * same silent-default failure D2 was raised for, inverted: every protected page
 * would render its signed-out state, and nobody would ever see that auth is not
 * merely signed out but unusable. A typed `AuthSecretMissingError` is loud and
 * cannot be confused with a signed-out user.
 *
 * WHY THE HEADER IS FORWARDED RATHER THAN REBUILT. Better Auth reads the session
 * cookie from the incoming `Headers`. `next/headers`' `headers()` returns the
 * request's own headers in a server context, so forwarding that object passes
 * the real cookie through untouched — including the cookie Better Auth itself set
 * earlier in the same response cycle. Returning `null` for a valid request that
 * carries no cookie is Better Auth's documented behaviour, not an error — which is
 * why a CONFIGURED `getSession()` returns `Session | null` and does not throw.
 */

import { headers as nextHeaders } from "next/headers";

import { auth, requireAuthSecret } from "./auth";

/**
 * The session shape Better Auth resolves: `{ session, user }`, or `null` when
 * there is no valid, unexpired session.
 *
 * Declared from the instance's own `$Infer` so it tracks whatever fields the
 * configured plugins add, rather than being restated here and going stale.
 */
export type AuthSession = typeof auth.$Infer.Session;

/**
 * Throws unless auth is configured well enough to answer a session question.
 *
 * FAIL-CLOSED, AT REQUEST TIME, on the same terms as the `[...all]` route guard:
 * a missing secret AND the library's published default are both refused, in every
 * `NODE_ENV` (the library only refuses the default under `production`). It is not
 * a module-scope check because `next build` and `bun run test` both import this
 * module with no `.env`.
 *
 * It is deliberately a THROW, not a fallback: see the module note. Any error other
 * than `AuthSecretMissingError` is none of this function's business — it does not
 * exist to catch anything.
 */
function requireConfiguredSession(): void {
  requireAuthSecret();
}

/**
 * Returns the current session, or `null` if the request carries none.
 *
 * THROWS `AuthSecretMissingError` when `BETTER_AUTH_SECRET` is missing or set to
 * Better Auth's published default — see the module note for why that is not
 * reported as a signed-out user.
 *
 * Must be called from a request scope (a server component, route handler or
 * server action) — it reads `next/headers`, which throws outside one. The secret
 * refusal is checked BEFORE the headers are read, so the unconfigured case fails
 * the same way everywhere rather than depending on a request being in flight.
 */
export async function getSession(): Promise<AuthSession | null> {
  requireConfiguredSession();
  return auth.api.getSession({
    headers: await nextHeaders(),
  });
}

/**
 * Whether the current request is signed in. Convenience over `getSession() !== null`
 * for the common guard-site read.
 *
 * Inherits `getSession()`'s refusal: it throws `AuthSecretMissingError` rather
 * than reporting `false` when auth is unconfigured. `false` is a claim about the
 * user; an unconfigured secret is a claim about the server, and this function must
 * not blur the two.
 */
export async function isSignedIn(): Promise<boolean> {
  return (await getSession()) !== null;
}
