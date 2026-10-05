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
  boolean,
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

/* ------------------------------------------------------------------------- *
 * Better Auth's four tables (T19).
 *
 * WHY THE PROPERTY NAMES ARE camelCase AND MUST STAY THAT WAY. The Drizzle
 * adapter addresses this schema two ways, both keyed on the Drizzle PROPERTY
 * name, never on the SQL column name:
 *   - `getSchema(model)` looks up `config.schema[model]`, so the EXPORT name must
 *     be `user` / `session` / `account` / `verification` (Better Auth's default
 *     singular `modelName`s; `usePlural` is NOT used, see below).
 *   - `convertWhereClause` / `getFieldName` index the table object with
 *     `getDefaultFieldName(...)`, whose result is the Better Auth FIELD key
 *     (`emailVerified`, `userId`, `createdAt`, ...) or whatever `fieldName` that
 *     key maps to. Verified in 1.7.7 against
 *     `getExpectedSchema({ emailAndPassword: { enabled: true } })`, which is also
 *     what `diffSchema` compares this schema against at runtime: a property that
 *     does not match a field key is reported as a missing column and every auth
 *     request throws SchemaMismatchError.
 *
 * WHY THE SQL COLUMN NAMES ARE camelCase TOO, against this file's own convention.
 * `app_meta` / `canonical_events` above map camelCase properties onto snake_case
 * SQL, which is this repo's convention -- but those tables are ours, whereas these
 * four are Better Auth's contract. Its CLI (`auth generate`) emits
 * `emailVerified boolean`, so shipping snake_case SQL here would mean the next
 * `auth generate`/`auth migrate` diffs every column for no reason. The card
 * permits snake_case "only where the existing schema's convention requires it";
 * here it does not, because nothing in DevLoop reads these tables by SQL name.
 * They are quoted identifiers, so `"user"` and `"emailVerified"` are unambiguous
 * even where `user` is a Postgres keyword.
 *
 * NEITHER `usePlural` NOR `schemaName` IS USED. `usePlural` would make the adapter
 * look for `users`/`sessions`/... , so the exported singular names below are
 * load-bearing. `schemaName` would put the tables in a Postgres namespace, which
 * adds a `search_path` dependency to every statement for no v1 benefit (DevLoop is
 * local-only, single database, D2).
 *
 * Every column here is INFRASTRUCTURE vocabulary and names no provider, so the
 * db/ persistence boundary guard (`src/__tests__/db-schema-boundary.test.ts`)
 * stays green; `providerId`/`accountId` on `account` are generic OAuth-provider
 * slots owned by the auth library, and no provider is named or configured.
 *
 * NO EXISTING TABLE IS RENAMED OR REORDERED. `app_meta` and `canonical_events`
 * keep their live `canonical_events_type_check` /
 * `canonical_events_metadata_is_object_check` constraints untouched.
 * ------------------------------------------------------------------------- */

/**
 * Auth user. DevLoop is a single local user (D2/D3), but the table is Better Auth's
 * and is left general rather than narrowed to one row.
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

/** Auth session. `userId` cascades on delete, matching the adapter's expectation. */
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    /** Opaque session token; unique so a token can never resolve to two rows. */
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    /** The adapter declares `userId` as an indexed field; mirror that. */
    index("session_user_id_idx").on(table.userId),
  ],
);

/**
 * Auth account: one credential or OAuth-provider row per linked identity.
 *
 * `accountId` + `providerId` is unique because that pair IS the account's natural
 * key -- it is how Better Auth finds the row to update on repeat sign-in, so a
 * duplicate would let one identity hold two accounts.
 */
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", {
      withTimezone: true,
    }),
    scope: text("scope"),
    /** Scrypt password hash. Nullable: a social-only account has none. */
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("account_account_id_provider_id_key").on(
      table.accountId,
      table.providerId,
    ),
    index("account_user_id_idx").on(table.userId),
  ],
);

/** Auth verification: email-verification and password-reset tokens. */
export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    /** The email (or other subject) the token was issued for. */
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (table) => [
    /** The adapter declares `identifier` as an indexed field; mirror that. */
    index("verification_identifier_idx").on(table.identifier),
  ],
);

export type AppMetaRow = typeof appMeta.$inferSelect;
export type NewAppMetaRow = typeof appMeta.$inferInsert;
export type CanonicalEventRow = typeof canonicalEvents.$inferSelect;
export type NewCanonicalEventRow = typeof canonicalEvents.$inferInsert;
export type UserRow = typeof user.$inferSelect;
export type NewUserRow = typeof user.$inferInsert;
export type SessionRow = typeof session.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type VerificationRow = typeof verification.$inferSelect;
