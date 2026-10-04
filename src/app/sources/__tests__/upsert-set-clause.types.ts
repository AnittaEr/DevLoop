/**
 * TYPE-LEVEL regression guard for the upsert's `set` clause (B36).
 *
 * WHY THIS FILE IS NOT A `.test.ts`. Every assertion here is enforced by `tsc`,
 * not by a runtime expectation: there is no runtime behaviour to assert, and
 * written as `*.test.ts` a future edit could satisfy it with a cast. Naming it
 * `.types.ts` means `bun run typecheck` fails the build if any assertion below
 * stops holding — which is the whole point, because the guarantee it protects is
 * a compile-time one and only the compiler can regress it. `tsconfig.json`
 * includes every `.ts` file in the repo, so this file is checked whether or not
 * any runner ever loads it.
 *
 * HOW THE NEGATIVE CASES ARE ASSERTED, and why the mechanism matters. Each
 * failing assignment carries `@ts-expect-error`. That directive is not merely a
 * comment: `tsc` REPORTS AN ERROR IF THE SUPPRESSED ERROR STOPS OCCURRING. So if
 * a future change ever widens the type back toward `any` and the misspelled
 * column becomes acceptable again, the build fails with "Unused
 * '@ts-expect-error' directive" rather than passing silently. That is what makes
 * these guards non-vacuous. My first draft of this file used distributive
 * conditional types resolving to `never` instead, and that proved NOTHING: an
 * unused `type X = ... ? ... : never` alias is never evaluated by anything, so
 * all nine assertions sat there reading as coverage while being inert. A
 * `@ts-expect-error` on a real assignment cannot be that inert.
 *
 * THE DEFECT THIS EXISTS FOR. `CanonicalEventUpsertBuilder` used to be typed
 * `PgInsertOnConflictDoUpdateConfig<AnyPgInsert>`, and
 * `AnyPgInsert = PgInsertBase<any, any, any, any, any, any>`, so `set` resolved
 * to `PgUpdateSetSource<any>` — an unconstrained, string-keyed map. A misspelled
 * column AND the primary key `id` in `UPSERT_UPDATED_COLUMNS` both typechecked
 * at exit 0, while the docstring directly above claimed the opposite.
 *
 * THE NON-OBVIOUS PART, and the finding worth keeping. Annotating the constant
 * is load-bearing because TypeScript's excess-property check applies only to a
 * FRESH object literal: `onConflictDoUpdate` is handed an already-evaluated
 * `const`, so the seam's `set` type alone could never have caught a bad key
 * inside it. Writing these assertions exposed that the two layers catch
 * DIFFERENT mistakes, so each is asserted against the layer that actually catches
 * it — {@link UpsertSetClause} for the natural key, Drizzle's own `set` for the
 * column names. Neither type is the guarantee on its own.
 */

import { sql } from "drizzle-orm";

import type {
  CanonicalEventConflictConfig,
  CanonicalEventWriter,
  UpsertSetClause,
} from "../index";

/**
 * Drizzle's own `set`, bound to the REAL table. This is the layer that rejects a
 * column name `canonical_events` does not have.
 */
type SetClause = CanonicalEventConflictConfig["set"];

/** The layer the constant is annotated with: Drizzle's `set` minus the key. */
type UpdateSet = UpsertSetClause;

/** Every real, non-key column, in the shape a valid upsert supplies them. */
const VALID_SET: UpdateSet = {
  type: sql`excluded.type`,
  title: sql`excluded.title`,
  url: sql`excluded.url`,
  author: sql`excluded.author`,
  metadata: sql`excluded.metadata`,
  occurredAt: sql`excluded.occurred_at`,
};

// ---------------------------------------------------------------------------
// POSITIVE. If the type were `PgUpdateSetSource<any>`, these would pass too — so
// they are not the proof. They are here to make the file fail if a future change
// over-tightens the type and rejects Drizzle's own legal `excluded.*` fragments,
// which would be a compile-time-only regression with no runtime symptom.
// ---------------------------------------------------------------------------

export const validSetIsAccepted: UpdateSet = VALID_SET;

/** A bound value is legal too — an update need not use `excluded.*`. */
export const boundValueIsAccepted: UpdateSet = { title: "a corrected title" };

/** `set` is all-optional: an update need not touch every mutable column. */
export const emptySetIsAccepted: UpdateSet = {};

/** A subset is accepted, which is what "not every column is written" means. */
export const partialSetIsAccepted: UpdateSet = { title: sql`excluded.title` };

/**
 * The six columns the constant actually names are all updatable — asserted
 * individually rather than as one literal, so a column being REMOVED from
 * `db/schema.ts` names itself in the error instead of silently vanishing inside
 * a single excess-property message.
 */
export const typeIsUpdatable: UpdateSet = { type: sql`excluded.type` };
export const titleIsUpdatable: UpdateSet = { title: sql`excluded.title` };
export const urlIsUpdatable: UpdateSet = { url: sql`excluded.url` };
export const authorIsUpdatable: UpdateSet = { author: sql`excluded.author` };
export const metadataIsUpdatable: UpdateSet = {
  metadata: sql`excluded.metadata`,
};
export const occurredAtIsUpdatable: UpdateSet = {
  occurredAt: sql`excluded.occurred_at`,
};

// ---------------------------------------------------------------------------
// NATURAL KEY. `UpsertSetClause` is Drizzle's `set` MINUS `id`/`source`/
// `externalId`, and that subtraction is the ONLY thing rejecting these — to
// Drizzle itself `id` is a perfectly legal `set` key. The
// `drizzleAloneWouldAcceptId` anchor below pins that fact, which is why the
// narrowing cannot be dropped as "redundant" by a future reader.
// ---------------------------------------------------------------------------

/**
 * The PRIMARY KEY is rejected — the specific case the docstring promised.
 *
 * Rewriting `id` on conflict would orphan anything referencing the row and
 * replace an existing entity with a different one.
 */
export const primaryKeyIsRejected: UpdateSet = {
  // @ts-expect-error 'id' is the primary key and must never appear in an update set.
  id: sql`excluded.id`,
};

/**
 * Neither is the rest of the natural key. `UNIQUE(source, external_id)` is the
 * constraint the upsert targets, so rewriting either moves the row out from
 * under its own conflict target and the arbiter stops matching.
 */
export const sourceKeyIsRejected: UpdateSet = {
  // @ts-expect-error 'source' is half the natural key, so it must not be rewritten.
  source: sql`excluded.source`,
};

/** The other half, separately: `externalId`, whose SQL name is `external_id`. */
export const externalKeyIsRejected: UpdateSet = {
  // @ts-expect-error 'externalId' is the other half of the natural key.
  externalId: sql`excluded.externalId`,
};

/**
 * The natural key is rejected even TOGETHER with valid columns, which is the
 * shape a careless edit takes: someone appends one more line to an existing
 * enumeration without thinking about which column they appended.
 */
export const naturalKeyAmongValidColumnsIsRejected: UpdateSet = {
  title: sql`excluded.title`,
  // @ts-expect-error 'id' is rejected even alongside otherwise-valid columns.
  id: sql`excluded.id`,
};

// ---------------------------------------------------------------------------
// COLUMN NAMES. Asserted against Drizzle's own `set`, which is where the check
// comes from; the constant's annotation inherits it unchanged.
// ---------------------------------------------------------------------------

/**
 * A misspelled column is rejected. `occurred_at` is the SQL column name, and it
 * is the exact mistake this guard exists for: a developer reading the generated
 * DDL rather than `db/schema.ts` writes it, and under the old `any` the only
 * thing that would ever find out is Postgres, mid-sync.
 */
export const misspelledColumnIsRejected: UpdateSet = {
  // @ts-expect-error 'occurred_at' is the SQL name; the Drizzle property is 'occurredAt'.
  occurred_at: sql`excluded.occurred_at`,
};

/**
 * A wholly invented column is rejected. Distinct from the misspelling above:
 * that one is a real column reached by its SQL name, this is a name that does
 * not exist at all. Under `PgUpdateSetSource<any>` both were accepted, and so
 * would this be.
 */
export const inventedColumnIsRejected: UpdateSet = {
  // @ts-expect-error 'titel' is not a column of canonical_events at all.
  titel: sql`excluded.titel`,
};

/** A plausible-looking case variant of a real column is rejected too. */
export const caseVariantIsRejected: UpdateSet = {
  // @ts-expect-error 'occurredat' is not the Drizzle property spelling.
  occurredat: sql`excluded.occurredat`,
};

/**
 * A column's VALUE is checked, not just its name: `occurredAt` is a
 * `timestamptz`, so a bare number for it must not typecheck. This is the other
 * half of what binding the real table buys — the old `any` also lost value
 * checking, though nothing in this repo currently exploits that.
 */
export const wrongValueTypeIsRejected: UpdateSet = {
  // @ts-expect-error occurredAt is a timestamptz, so it takes a Date or an SQL fragment, not a number.
  occurredAt: 12345,
};

/**
 * THE FALSIFICATION ANCHOR. `id` IS a legal key to Drizzle's own `set`, so this
 * assignment is EXPECTED TO COMPILE and deliberately carries no directive. It
 * pins the fact that makes {@link UpsertSetClause} load-bearing rather than
 * redundant.
 */
export const drizzleAloneWouldAcceptId: SetClause = { id: sql`excluded.id` };

// ---------------------------------------------------------------------------
// THE FAKE-IMPLEMENTATION USE CASE, preserved.
//
// The old comment said the `any` was there so a fake provider could implement
// the seam without depending on the schema. Binding the real table must not
// break that, and it does not: method PARAMETERS are checked bivariantly, so a
// fake declaring a loose config still satisfies the interface. `RecordingWriter`
// in `composition-root.test.ts` is written exactly this way, and this pair of
// assertions is the standing proof — if a future change hand-rolls the config
// type or tightens the variance, `bun run typecheck` turns red HERE instead of
// breaking every recording fake in the suite with a confusing error.
// ---------------------------------------------------------------------------

/** A recording fake's conflict handler, written as loosely as the suite does. */
type LooseOnConflictDoUpdate = (config: {
  target: unknown;
  set: Record<string, unknown>;
}) => PromiseLike<unknown>;

/** The loose fake writer shape, naming no column and importing no schema type. */
type LooseFakeWriter = {
  insert(table: unknown): {
    values(rows: Record<string, unknown>[]): {
      onConflictDoUpdate: LooseOnConflictDoUpdate;
    };
  };
};

/**
 * The fake satisfies `CanonicalEventWriter` despite the narrowed seam. Held in an
 * alias and consumed by the export below, so the compatibility is actually
 * CHECKED rather than merely described.
 */
type FakeSatisfiesSeam = LooseFakeWriter extends CanonicalEventWriter
  ? true
  : false;

/**
 * TRUE — the fake is assignable to the narrowed seam.
 *
 * Spelled out with the `extends true` step because this is the load-bearing
 * claim of the whole narrowing, and it is only a claim until something requires
 * it to resolve to `true`.
 */
export type FakeIsAssignableToTheSeam = FakeSatisfiesSeam extends true
  ? true
  : never;

/**
 * And the claim is consumed by a real assignment, so it cannot go quietly false
 * in an unused alias. Under the old `any` seam this held trivially; under the
 * narrowed seam it holds because TypeScript compares method parameters
 * bivariantly, and this is where that fact is pinned.
 */
export const fakeIsAssignableToTheSeam: FakeIsAssignableToTheSeam = true;
