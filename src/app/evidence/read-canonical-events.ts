/**
 * Reading persisted canonical events back out (T20).
 *
 * WHY THIS FILE EXISTS. Until T20 nothing in the app ever SELECTed from
 * `canonical_events`: the sync route only writes, so there was no read path to
 * reuse. This is that path, and it is deliberately the smallest thing that can
 * exist — a row read plus the existing mapper back to the domain type. It does
 * NOT aggregate, order, filter or periodise: that is `src/core/evidence/
 * timeline.ts`'s job, and that module is pure and is used as shipped rather
 * than reimplemented here.
 *
 * WHY IT LIVES UNDER `src/app/**` AND NOT IN `src/core/**`. `db/**` owns
 * persistence mechanics and `src/core/**` owns provider-neutral domain logic,
 * but the composition of the two — "read these rows, hand them to the neutral
 * helper" — is the composition root's job, exactly as `src/app/sources/index.ts`
 * states for the plugin wiring. Putting it in core would mean core importing
 * `db/schema`, which is the dependency direction core must not have.
 *
 * THE WRITER IS INJECTED, NOT AMBIENTLY RESOLVED, for the same reason
 * `persistCanonicalEvents` takes one: a default of `getDb()` in a parameter
 * position is evaluated on EVERY call, including by a test that supplies its
 * own, which would demand `DATABASE_URL` from a caller that never touches a
 * database. The default is applied inside the function body instead, after the
 * empty-result short circuit.
 *
 * PROVIDER NEUTRALITY (hard rule 1). This file names `canonical_events` columns
 * and nothing else. `source` is carried through as the opaque string the column
 * holds and is never interpreted, matched against a vendor, or renamed. No
 * provider vocabulary appears here, in the page, or in any column the page
 * renders.
 */

import type { CanonicalEvent } from "@/core/events/canonical-event";
import { canonicalEvents } from "../../../db/schema";
import type { CanonicalEventRow } from "../../../db/schema";
import { fromCanonicalEventRow } from "../../../db/canonical-event-mapper";
import { getDb } from "@/lib/db/client";

/**
 * The narrow slice of a Drizzle database this module needs: one SELECT.
 *
 * Structural, for the same reason `CanonicalEventWriter` in
 * `src/app/sources/index.ts` is: a test can hand in a recording fake and assert
 * what would have been read. `bun run typecheck` pins that the real client
 * returned by `getDb()` still satisfies it, so the seam and production cannot
 * drift apart silently.
 *
 * The rows come back as SELECT rows, NOT as `CanonicalEvent`s. That is
 * deliberate and it is what makes the mapper load-bearing rather than
 * decorative: `occurred_at` is a `timestamptz` in the database and an ISO-8601
 * string on the domain type, so the conversion is
 * `fromCanonicalEventRow`'s job. Typing this seam as `CanonicalEvent[]` would
 * let a caller skip that conversion and render a `Date` as if it were already a
 * string — which typechecks and then renders wrongly.
 */
export interface CanonicalEventReader {
  select(): {
    from(table: typeof canonicalEvents): PromiseLike<CanonicalEventRow[]>;
  };
}

/** Typed outcomes, so a caller renders a refusal instead of a stack trace. */
export const READ_OUTCOMES = {
  /** The rows were read (possibly zero of them). */
  ok: "ok",
  /**
   * `DATABASE_URL` is unset or Postgres is unreachable. This is a claim about
   * the SERVER, never about the visitor, and it is kept distinct from the auth
   * refusals so the page can name which one it is.
   */
  databaseUnavailable: "database_unavailable",
} as const;

export type ReadOutcome = (typeof READ_OUTCOMES)[keyof typeof READ_OUTCOMES];

export type ReadResult =
  | {
      readonly ok: true;
      readonly outcome: typeof READ_OUTCOMES.ok;
      readonly events: CanonicalEvent[];
    }
  | {
      readonly ok: false;
      readonly outcome: typeof READ_OUTCOMES.databaseUnavailable;
      readonly message: string;
      /**
       * Always 0. Stated so a caller reading only this object sees that no event
       * data was produced, mirroring the session guard's refusal body.
       */
      readonly fetched: 0;
    };

/**
 * Read every persisted canonical event, oldest first.
 *
 * THE ORDER IS THE DATABASE'S, NOT A SECOND RULE. `occurred_at ASC` is asked for
 * once, here, and `buildEvidenceTimeline` sorts chronologically with a STABLE
 * sort anyway, so equal instants keep this order. Sorting here as well would be
 * a second ordering rule that could disagree with the helper's about ties.
 *
 * `id` is the tiebreaker only because `occurred_at` is not unique; without it
 * Postgres may return equal-instant rows in any order, which would make the
 * page's output non-reproducible between runs over identical data.
 *
 * NEVER THROWS for an unreachable database: it returns
 * `database_unavailable`. A page that rendered a 500 for a stopped local
 * Postgres would be indistinguishable, in a screenshot, from a bug in the page.
 */
export async function readCanonicalEvents(
  reader?: CanonicalEventReader,
): Promise<ReadResult> {
  try {
    // Resolved here, not as a default parameter value: a default is evaluated
    // on every call, including by a caller that supplies its own reader, which
    // would demand DATABASE_URL from a test that never touches a database.
    //
    // The single-value type is load-bearing. `reader ?? getDb()` infers a UNION
    // of the seam and the real Drizzle client, and calling `.select().from()` on
    // a union picks the intersection of their overloads, so the row type widens
    // to `{} | {...}` and `fromCanonicalEventRow` stops typechecking. Pinning
    // the seam type makes the call resolve against ONE signature — and
    // `bun run typecheck` is what proves the real client still satisfies it, so
    // this is a narrowing with a compiler-enforced check behind it, not a cast.
    const source: CanonicalEventReader = reader ?? getDb();
    const rows = await source.select().from(canonicalEvents);

    return {
      ok: true,
      outcome: READ_OUTCOMES.ok,
      events: rows.map((row) => fromCanonicalEventRow(row)),
    };
  } catch {
    // The driver's own message can name a host, a database or a role, none of
    // which belongs in a rendered page, and the connection string must never be
    // echoed. The reason is therefore a FIXED literal naming the variable, in
    // the same style as `requireAuthSecret()` in `src/lib/auth.ts`.
    return {
      ok: false,
      outcome: READ_OUTCOMES.databaseUnavailable,
      message:
        "The evidence database is not reachable, so no events can be read. " +
        "DATABASE_URL is unset or the local Postgres is not running. " +
        "This is a server-side configuration problem, not a missing sign-in.",
      fetched: 0,
    };
  }
}
