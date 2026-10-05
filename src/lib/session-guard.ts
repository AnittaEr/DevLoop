/**
 * The one session guard (B46).
 *
 * WHAT THIS IS. A single reusable seam that answers "is this request allowed to
 * act as the user?" and, when it is not, says WHICH of two different things is
 * wrong. Route handlers call it; the evidence pages a later card builds (T20,
 * `t_911d21fa`) call it too. Its reason for existing is that a guard copied
 * into each call site is a guard that one call site will eventually get wrong.
 *
 * WHY IT READS THROUGH `getSession()` AND NEVER `auth.api.getSession`.
 * `src/lib/auth-session.ts` exists so a call site cannot forget to forward the
 * request headers — the standard way a server-side session check silently
 * reports "signed out" for a user who is actually signed in. Re-implementing
 * cookie reading here would reintroduce exactly the defect that module was
 * written to prevent, so this file imports the helper and nothing else from
 * `src/lib/auth.ts`.
 *
 * WHY IT MUST DISTINGUISH THREE OUTCOMES, NOT TWO. `getSession()` throws
 * `AuthSecretMissingError` when `BETTER_AUTH_SECRET` is missing or set to
 * Better Auth's published default — deliberately, so a broken `.env` is loud
 * rather than being reported as a signed-out user (see that module's header).
 * So the two failure states are genuinely different and must not collapse:
 *
 *   - signed in             -> `ok: true`, the caller proceeds;
 *   - no session            -> HTTP 401, "nobody is signed in";
 *   - auth NOT CONFIGURED   -> HTTP 503, "this server cannot tell who anyone is".
 *
 * The trap this file exists to avoid: `try { await getSession() } catch { 401 }`
 * compiles, passes every test written against "secret set, no cookie" (which
 * returns a clean `null`), and answers 401 for a server that cannot authenticate
 * at all — hiding a broken `.env` indefinitely, the same silent-default failure
 * D2 and D5 were raised to kill. A misconfiguration must never masquerade as a
 * signed-out user.
 *
 * WHY 503 FOR THE MISCONFIGURATION, DEFENDED. The status is the one the shipped
 * `[...all]` route already uses for this exact condition (`auth_not_configured`,
 * T19), so the two guards agree instead of inventing a second vocabulary for
 * the same fact. It is also the honest one: the server process is fine and the
 * operator's configuration is not, and the two are worth distinguishing in a
 * log. 401 is a claim about the CALLER; reporting it when the fault is the
 * SERVER's is the misreport.
 *
 * NO SECRET IS READ, LOGGED OR ECHOED. The only thing this module inspects is
 * whether `getSession()` produced a session. The refusal body carries a FIXED
 * literal message plus the `AuthSecretMissingError` message, which names the
 * VARIABLE and never its value — the same property T19's route relies on.
 *
 * WHY IMPORTING THIS MUST NOT THROW. `next build` and `bun run test` both import
 * every module in `src/lib` with no `.env`, no `DATABASE_URL` and no request in
 * flight. Nothing here runs at module scope, so `next/headers` is not touched
 * until `requireSession()` is actually called inside a request.
 *
 * PLUGIN BOUNDARY. This module imports `./auth-session` and `./auth` only. No
 * GitHub type crosses into it.
 */

import { AuthSecretMissingError } from "./auth";
import { getSession } from "./auth-session";
import type { AuthSession } from "./auth-session";

/** The condition this module reports, for a caller that switches on it. */
export const SESSION_GUARD_OUTCOMES = {
  /** A valid, unexpired session is present. The caller may proceed. */
  authenticated: "authenticated",
  /** Auth works; this request simply carries no valid session. HTTP 401. */
  sessionRequired: "session_required",
  /** Auth cannot answer at all (`BETTER_AUTH_SECRET` missing/default). HTTP 503. */
  authNotConfigured: "auth_not_configured",
} as const;

export type SessionGuardOutcome =
  (typeof SESSION_GUARD_OUTCOMES)[keyof typeof SESSION_GUARD_OUTCOMES];

/** The refusals, as they go on the wire. Fixed text; never an error rendered. */
export interface SessionRefusalBody {
  readonly ok: false;
  readonly outcome: Exclude<SessionGuardOutcome, "authenticated">;
  readonly message: string;
  /** Always 0. Stated so a caller reading only the JSON sees no work happened. */
  readonly fetched: 0;
  /** Always 0, and asserted as such by the guard's own suite. */
  readonly persisted: 0;
}

export type SessionGuardResult =
  | {
      readonly ok: true;
      readonly outcome: typeof SESSION_GUARD_OUTCOMES.authenticated;
      readonly session: AuthSession;
    }
  | {
      readonly ok: false;
      readonly outcome: Exclude<SessionGuardOutcome, "authenticated">;
      readonly status: 401 | 503;
      readonly body: SessionRefusalBody;
    };

/** Why the session is absent, in words a human can act on. A FIXED literal. */
const SESSION_REQUIRED_MESSAGE =
  "No valid session. Sign in first: this request carried no unexpired session cookie, so it was refused before any work was done.";

/**
 * Ask the ONE seam whether this request may act as the user.
 *
 * Never throws for either refusal: both are ordinary returned answers, because
 * a route handler has to map them to statuses and a page has to render them.
 * Anything that is not a recognised auth misconfiguration propagates untouched
 * — this is a guard, not an error handler, and swallowing an unrelated bug would
 * report it as "nobody is signed in".
 *
 * Must be called from a request scope: `getSession()` reads `next/headers`.
 */
export async function requireSession(): Promise<SessionGuardResult> {
  try {
    const session = await getSession();

    if (session === null) {
      return refusal(
        SESSION_GUARD_OUTCOMES.sessionRequired,
        401,
        SESSION_REQUIRED_MESSAGE,
      );
    }

    return {
      ok: true,
      outcome: SESSION_GUARD_OUTCOMES.authenticated,
      session,
    };
  } catch (error) {
    // The ONLY error this module interprets. Anything else is rethrown, so a
    // bug in the database adapter cannot be reported to a caller as a 401.
    if (error instanceof AuthSecretMissingError) {
      return refusal(
        SESSION_GUARD_OUTCOMES.authNotConfigured,
        503,
        error.message,
      );
    }
    throw error;
  }
}

function refusal(
  outcome: Exclude<SessionGuardOutcome, "authenticated">,
  status: 401 | 503,
  message: string,
): SessionGuardResult {
  return {
    ok: false,
    outcome,
    status,
    body: {
      ok: false,
      outcome,
      message,
      fetched: 0,
      persisted: 0,
    },
  };
}

// Nothing above this line runs at import time: no `next/headers` read, no
// secret read, no session lookup. See the module header's last paragraph.
