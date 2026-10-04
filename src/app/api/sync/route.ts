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
 * IS IT SAFE TO CALL REPEATEDLY? NO -- and the response says so, in every
 * response, in `idempotent: false` plus `idempotencyNote`. Calling it twice
 * cannot duplicate rows (`UNIQUE (source, external_id)`), but the second call
 * FAILS with `already_present` / HTTP 409 rather than updating existing rows.
 * The full reasoning is in `handler.ts`; this card must not invent an
 * idempotency key to paper over a persistence-layer gap.
 *
 * No authentication here (explicitly out of scope for this card). DevLoop is
 * local-only in v1 (D2) and the route binds through `next start` on localhost.
 *
 * The logic lives in `./handler`, not here: Next.js validates a `route.ts`
 * module's exports against generated types and rejects anything that is not an
 * HTTP method or route-segment config, so the exported-and-tested unit is a
 * sibling module.
 */

import { handleSyncRequest } from "./handler";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const { status, body } = await handleSyncRequest();
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
