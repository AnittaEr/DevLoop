/**
 * POST /api/sync -- the one route a human can hit to run a sync (T15).
 *
 * PATH AND METHOD, AND WHY.
 *
 * - Path: `/api/sync`. `src/app/api/**` is Next.js's own reserved segment for
 *   HTTP endpoints, so this file exists only because of that convention, and
 *   the URL is therefore `/api` + `/sync`.
 * - Method: `POST`, not GET. A GET must be safe and idempotent, and a sync
 *   WRITES rows. Answering a write to GET would let a browser prefetch, a
 *   crawler, or a `<img src>` trigger it, which is precisely why this is not
 *   GET. `dynamic = "force-dynamic"` is set because the route's entire output
 *   depends on live upstream and database state; a cached 200 would be a lie.
 *
 * IS IT SAFE TO CALL REPEATEDLY? YES -- and the response says so, in every
 * response, in `idempotent: true` plus `idempotencyNote`. The write path is an
 * `ON CONFLICT DO UPDATE` upsert whose arbiter is
 * `UNIQUE (source, external_id)`, so calling it twice cannot duplicate rows and
 * does not fail: the second call converges on the existing row and refreshes its
 * mutable columns from the source's current view. `already_present` / HTTP 409 is
 * still reachable, but NOT by repeating this route -- it is reserved for a row
 * whose PRIMARY KEY `id` collides while its `(source, external_id)` does not,
 * which `ON CONFLICT` cannot absorb. The full reasoning is in `handler.ts`.
 *
 * AUTHENTICATION (B46). This route WRITES rows, so it requires a session, and
 * it asks the ONE reusable seam for that answer rather than reading cookies
 * here: `requireSession()` in `src/lib/session-guard.ts`, which delegates to
 * `getSession()` in `src/lib/auth-session.ts`. A second cookie-reading path here
 * would be exactly the defect that module was written to prevent.
 *
 * THREE ANSWERS, THREE RESPONSES. `requireSession()` distinguishes a signed-in
 * caller (proceed, unchanged), no session (401 `session_required`) and auth
 * being UNCONFIGURED because `BETTER_AUTH_SECRET` is missing or default (503
 * `auth_not_configured`, matching the `[...all]` route's vocabulary). The third
 * is deliberately not a 401: a server that cannot tell who anyone is must not
 * report that nobody is signed in, or a broken `.env` hides indefinitely.
 *
 * DevLoop is local-only in v1 (D2), which reduces exposure but does not remove
 * it — a browser on the same network reaches localhost fine.
 *
 * The logic lives in `./handler`, not here: Next.js validates a `route.ts`
 * module's exports against generated types and rejects anything that is not an
 * HTTP method or route-segment config, so the exported-and-tested unit is a
 * sibling module.
 */

import { handleSyncRequest } from "./handler";
import { requireSession } from "@/lib/session-guard";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const guard = await requireSession();
  if (guard.ok === false) {
    // Returned BEFORE `handleSyncRequest()` is reached, so no registry is
    // resolved, no plugin is consulted, and no row is written. The refusal body
    // is the guard's own fixed text; nothing here reads the secret.
    return Response.json(guard.body, {
      status: guard.status,
      headers: { "cache-control": "no-store" },
    });
  }

  const { status, body } = await handleSyncRequest();
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
