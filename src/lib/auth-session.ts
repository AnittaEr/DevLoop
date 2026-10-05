/**
 * Session helper (T19).
 *
 * A thin, typed wrapper over Better Auth's `auth.api.getSession` for server
 * components and route handlers. It exists so a caller reads one function instead
 * of remembering to forward request headers — the single most common way a
 * server-side session check silently reports "signed out" for a user who is
 * actually signed in.
 *
 * NO PROTECTION LOGIC HERE. Deciding what to do with a missing session (redirect,
 * 401, render a login link) belongs to the routes that consume this, and route
 * protection is a later card. This module only answers the question.
 *
 * WHY THE HEADER IS FORWARDED RATHER THAN REBUILT. Better Auth reads the session
 * cookie from the incoming `Headers`. `next/headers`' `headers()` returns the
 * request's own headers in a server context, so forwarding that object passes
 * the real cookie through untouched — including the cookie Better Auth itself set
 * earlier in the same response cycle. Returning `null` for a missing cookie is
 * Better Auth's documented behaviour, not an error, which is why this returns
 * `Session | null` and never throws.
 */

import { headers as nextHeaders } from "next/headers";

import { auth } from "./auth";

/**
 * The session shape Better Auth resolves: `{ session, user }`, or `null` when
 * there is no valid, unexpired session.
 *
 * Declared from the instance's own `$Infer` so it tracks whatever fields the
 * configured plugins add, rather than being restated here and going stale.
 */
export type AuthSession = typeof auth.$Infer.Session;

/**
 * Returns the current session, or `null` if the request carries none.
 *
 * Must be called from a request scope (a server component, route handler or
 * server action) — it reads `next/headers`, which throws outside one.
 */
export async function getSession(): Promise<AuthSession | null> {
  return auth.api.getSession({
    headers: await nextHeaders(),
  });
}

/**
 * Whether the current request is signed in. Convenience over `getSession() !== null`
 * for the common guard-site read.
 */
export async function isSignedIn(): Promise<boolean> {
  return (await getSession()) !== null;
}
