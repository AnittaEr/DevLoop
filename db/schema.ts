/**
 * Drizzle schema root for DevLoop.
 *
 * SCOPE (T5): this file owns persistence MECHANICS only — it proves the schema ->
 * migration -> client path works end to end. It deliberately contains NO
 * provider-specific (GitHub) columns: a persisted column name derived from a
 * provider's vocabulary would breach hard rule 1 permanently, because a schema
 * is not a lintable import. The canonical-events table below is owned by T7b
 * (`t_beb5f9c1`) and conforms to the core domain type that card matches; it uses
 * DevLoop's own vocabulary only.
 */

import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import type {
  CanonicalEventType,
  JsonObject,
} from "../src/core/events/canonical-event";
import { CANONICAL_EVENT_TYPES } from "../src/core/events/canonical-event";

/**
 * Generic key/value application metadata store.
 *
 * Infrastructure only: used by the migration/DX machinery, carries no product or
 * provider semantics.
 */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The persisted canonical event: `CanonicalEvent` (src/core/events/canonical-event.ts)
 * stored losslessly.
 *
 * Column names mirror the core domain type exactly and are DevLoop's own
 * vocabulary. `externalId` is deliberately opaque and provider-local; nothing here
 * names a provider, because a schema is not a lintable import — a provider-named
 * column would breach hard rule 1 with nothing able to catch it.
 *
 * `type` is constrained with a CHECK rather than a Postgres ENUM, and the CHECK's
 * allowed values are generated from `CANONICAL_EVENT_TYPES` so the constraint
 * cannot silently drift from the TypeScript union. CHECK was chosen over ENUM
 * because the value set lives in TypeScript and may still gain members: adding an
 * ENUM value in Postgres requires `ALTER TYPE ... ADD VALUE` with its own
 * transaction restrictions and is not cheaply reversible, whereas a CHECK is just
 * another generated migration like every other change to this schema.
 *
 * DRIFT IS ENFORCED IN CI, NOT ONLY BY GENERATION (B27). "Generated from the
 * array" is only true at generation time — a committed migration inlines static
 * SQL literals, so adding a member to `CANONICAL_EVENT_TYPES` without running
 * `bun run db:generate` would ship a database whose CHECK rejects the new value
 * at insert time. Nothing in `bun run test` or `bun run lint` can see this,
 * because `vitest.config.ts` collects `src/**` only and the DB suite needs a
 * live Postgres. The control is the `Database migrations in sync` step in
 * `.github/workflows/ci.yml`: it regenerates and fails if `db/migrations`
 * differs from the committed tree.
 */
export const canonicalEvents = pgTable(
  "canonical_events",
  {
    /** DevLoop-internal stable id, derived from source + externalId. */
    id: text("id").primaryKey(),
    /** Opaque source discriminator (a plugin's `describe().name`). */
    source: text("source").notNull(),
    /** Identifier assigned by the source; unique only within `source`. */
    externalId: text("external_id").notNull(),
    /**
     * The ROLE the event plays in DevLoop.
     *
     * `$type` narrows the column from `string` to `CanonicalEventType` so a
     * TYPED insert (`NewCanonicalEventRow`, i.e. what `toCanonicalEventRow`
     * returns) cannot carry a value outside the union — the mistake is caught
     * by `tsc` instead of by Postgres at insert time. The database-side CHECK
     * below remains the enforcement boundary for anything that reaches the
     * table without going through these types (raw SQL, a future writer).
     *
     * The DDL is unchanged: `text("type")` still emits `"type" text NOT NULL`,
     * so this is a compile-time narrowing only and mints no migration.
     */
    type: text("type").$type<CanonicalEventType>().notNull(),
    title: text("title").notNull(),
    /**
     * When the event happened at the source. Stored as `timestamptz`, so the
     * mapper parses the type's ISO-8601 string on write and the read path
     * re-serialises to ISO-8601 on read.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Canonical web URL, when the source exposes one. */
    url: text("url"),
    /** Display handle of the actor, when known. */
    author: text("author"),
    /**
     * Provider-supplied extra data. NOT NULL with a `{}` default rather than
     * nullable: a NULL metadata is indistinguishable downstream from an event that
     * carried no extra data, and the type says it is always present.
     *
     * `$type<JsonObject>()` narrows the column from `unknown` to the core
     * domain's JSON-safe bag, so the type contract is visible at the column
     * rather than only at the mapper. The `jsonb_typeof` CHECK below is what
     * actually enforces it in the database — `jsonb NOT NULL` alone still
     * admits JSON `null`, an array, or a bare scalar, and the mapper would then
     * silently reshape it into something the type never promised.
     */
    metadata: jsonb("metadata").$type<JsonObject>().notNull().default({}),
  },
  (table) => [
    /**
     * The natural key, enforced as a UNIQUE constraint rather than a bare index so
     * an idempotent upsert (T107) cannot silently double-write.
     */
    unique("canonical_events_source_external_id_key").on(
      table.source,
      table.externalId,
    ),
    /** Supports listing events newest-first. */
    index("canonical_events_occurred_at_idx").on(table.occurredAt),
    /**
     * Database-level enforcement that `type` is a member of CanonicalEventType.
     *
     * The allowed values are inlined as quoted SQL literals rather than bound
     * parameters: a CHECK constraint is DDL, and a bound parameter is not
     * permitted in a `CREATE TABLE` constraint — emitting `in ($1, $2, ...)`
     * produces a migration that fails to apply. The values still come from
     * `CANONICAL_EVENT_TYPES`, so the constraint cannot drift from the type.
     */
    check(
      "canonical_events_type_check",
      // Built as one raw fragment: interpolating `sql.raw` into a `sql` template
      // would re-bind it as a parameter and emit `[object Object]`.
      sql.raw(
        `"type" in (${CANONICAL_EVENT_TYPES.map((type) =>
          quoteSqlLiteral(type),
        ).join(", ")})`,
      ),
    ),
    /**
     * Database-level enforcement that `metadata` really is a JSON OBJECT.
     *
     * `metadata jsonb NOT NULL DEFAULT '{}'` does NOT enforce `JsonObject`:
     * Postgres happily stores JSON `null`, `[]`, `"a string"` and `42` in that
     * column, and each of those violates `CanonicalEvent["metadata"]`'s
     * `{ [key: string]: JsonValue }` contract. `jsonb_typeof` is the one
     * Postgres function that distinguishes those: it returns `null` for JSON
     * null, `array` for an array, `object` only for a real object.
     *
     * Note this CHECK is about the SHAPE, and unlike the type CHECK above it is
     * NOT generated from a TypeScript value set — there is nothing to drift
     * from. It states a property of JSON itself, so it cannot become stale the
     * way the enumerated value list can. The drift control for THAT list is the
     * CI step in `.github/workflows/ci.yml` which runs `bun run db:generate` and
     * fails if `db/migrations` changes.
     */
    check(
      "canonical_events_metadata_is_object_check",
      sql.raw(`jsonb_typeof("metadata") = 'object'`),
    ),
  ],
);

/**
 * Escapes a value for embedding in a single-quoted SQL string literal.
 *
 * Only ever called with members of CANONICAL_EVENT_TYPES (fixed identifiers
 * from this repo's own source), but it escapes defensively so that adding a
 * value containing a quote can never produce a broken or injectable migration.
 */
function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export type AppMetaRow = typeof appMeta.$inferSelect;
export type NewAppMetaRow = typeof appMeta.$inferInsert;
export type CanonicalEventRow = typeof canonicalEvents.$inferSelect;
export type NewCanonicalEventRow = typeof canonicalEvents.$inferInsert;
