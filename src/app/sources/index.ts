/**
 * The composition root for DevLoop's data sources.
 *
 * `src/core/plugins/registry.ts` says so itself: "the registry holds
 * already-constructed plugin instances. Wiring a concrete source into the app is
 * the composition root's job, outside `src/core/**`." This module is that job.
 * It is the ONE place where the neutral core contracts and the concrete
 * `src/plugins/github/**` implementation meet, and it is why the boundary lint
 * rule is scoped to `src/core/**` alone (see `eslint.config.mjs:52-55`).
 *
 * WHAT THIS MODULE IS NOT. It is a plain typed module: no React component, no
 * route handler, no polling, no scheduling. Presentation is a later card's
 * job, and the note on this card is explicit that a composition root carrying
 * source vocabulary in a component is scope creep.
 *
 * SECRET HYGIENE. The credential is never read, logged, echoed or accepted
 * here. The plugin is handed a {@link CredentialProvider} obtained from the
 * core factory, and that provider resolves the token lazily inside
 * `getToken()`. This module never holds a token value in a variable, a field,
 * a fixture, a log line or an error message — there is no code path here that
 * could, which is a stronger property than redacting one.
 *
 * WHY THE CONFIG COMES FROM AN ENVIRONMENT VARIABLE. The repository to read is
 * deployment configuration, not code, so `getSourceRegistry()` reads
 * {@link REPOSITORY_ENV_VAR}. It is the *name* of the variable that appears in
 * the error when it is unset; no value is ever read into this module.
 */

import { sql } from "drizzle-orm";
import type {
  PgInsert,
  PgInsertOnConflictDoUpdateConfig,
} from "drizzle-orm/pg-core/query-builders/insert";

import type { CanonicalEvent } from "@/core/events/canonical-event";
import { createCredentialProvider } from "@/core/credentials/factory";
import type { EnvReader } from "@/core/credentials/env-provider";
import type { RegisteredPlugin } from "@/core/plugins/plugin";
import { PluginRegistry } from "@/core/plugins/registry";
import type {
  CanonicalEventRow,
  NewCanonicalEventRow,
} from "../../../db/schema";
import { canonicalEvents } from "../../../db/schema";
import { toCanonicalEventRow } from "../../../db/canonical-event-mapper";
import { getDb } from "@/lib/db/client";
import {
  GitHubSourcePlugin,
  SOURCE_NAME,
} from "@/plugins/github/github-plugin";
import type { HttpTransport } from "@/plugins/github/transport";
import { createFetchTransport } from "@/plugins/github/transport";
import { GITHUB_TOKEN_PROFILE } from "@/plugins/github/token-profile";

export { SOURCE_NAME };

/**
 * Name of the environment variable holding `owner/name` of the repository to
 * ingest. Name only — this module never reads a repository from anywhere else.
 */
export const REPOSITORY_ENV_VAR = "DEVLOOP_REPOSITORY";

/** Raised when the composition root is asked for a source it cannot build. */
export class SourceConfigurationError extends Error {
  override readonly name = "SourceConfigurationError";

  constructor(reason: SourceConfigurationReason) {
    super(reason);
    Object.setPrototypeOf(this, SourceConfigurationError.prototype);
  }
}

/**
 * Fixed reasons for {@link SourceConfigurationError}.
 *
 * A closed set of fixed strings, for the same reason
 * `src/core/credentials/provider.ts` keeps one: a throw site selects a member,
 * it never assembles a string from caller input, so no configuration value can
 * reach the message.
 */
export const SOURCE_CONFIGURATION_REASONS = {
  repositoryUnset: `${REPOSITORY_ENV_VAR} is not set, so no source can be built.`,
  unknownSource: "the requested source is not registered.",
  transportUnavailable:
    "no HTTP transport is available in this runtime, so no source can be built.",
} as const;

export type SourceConfigurationReason =
  (typeof SOURCE_CONFIGURATION_REASONS)[keyof typeof SOURCE_CONFIGURATION_REASONS];

/**
 * Codes for a {@link SyncFailure}. A closed set, for the same reason
 * {@link SOURCE_CONFIGURATION_REASONS} is one: a failure site selects a member,
 * it never assembles a code from anything at runtime.
 *
 * Deliberately ONE code for every mapper rejection rather than one per reason.
 * The writer already distinguishes its own rejections by message, and this
 * module does not re-derive that taxonomy — a second classification of the same
 * throw sites is precisely how two layers drift apart, which is the disagreement
 * this guard exists to surface. {@link SyncFailure.detail} carries the writer's
 * own message verbatim instead.
 */
export const SYNC_FAILURE_CODES = {
  /** The writer refused at least one event; nothing was written. */
  eventNotPersistable: "event_not_persistable",
} as const;

export type SyncFailureCode =
  (typeof SYNC_FAILURE_CODES)[keyof typeof SYNC_FAILURE_CODES];

/**
 * How much of the batch a refusal names.
 *
 * TWO SCOPES, AND THE DISTINCTION IS NOT COSMETIC. `persistCanonicalEvents`
 * maps and deduplicates the whole page and then executes ONE statement, so a
 * refusal raised by the DATABASE arrives with no offending row attached to it —
 * Postgres names the row it was inserting, not the one the constraint came from
 * among several. Inventing an index there would be a fabricated answer, so a
 * page-scope refusal says plainly that no single event is identified.
 */
export const SYNC_FAILURE_SCOPES = {
  /** One event is named; `index`, `eventId` and `externalId` are present. */
  event: "event",
  /** The batch was refused as a whole; no single event is identified. */
  page: "page",
} as const;

export type SyncFailureScope =
  (typeof SYNC_FAILURE_SCOPES)[keyof typeof SYNC_FAILURE_SCOPES];

/**
 * A classified, reported sync failure.
 *
 * `detail` is the writer's rejection message carried VERBATIM, and it names the
 * offending value. That is the point of the guard: the caller learns not merely
 * that a sync failed but WHY an event was refused, without this module
 * paraphrasing a rule the persistence layer owns.
 *
 * The three identifying fields are OPTIONAL, and `scope` is what says whether
 * they are there. They were required when the only possible refusal was a
 * per-event mapper rejection, which does name its event; a database-raised
 * refusal does not, so making them required would force a caller-facing lie
 * rather than a type error. `scope: "event"` still guarantees all three, and
 * that is asserted by construction at the throw site.
 */
export interface SyncFailure {
  readonly code: SyncFailureCode;
  /** Whether one event is named or the whole batch was refused. */
  readonly scope: SyncFailureScope;
  /** Position of the refused event in the fetched page, 0-based. */
  readonly index?: number;
  /** Canonical id of the refused event, so it can be found and re-fetched. */
  readonly eventId?: string;
  /** Provider-scoped id of the refused event, the same value under a swap. */
  readonly externalId?: string;
  /** The writer's own rejection message, unaltered. */
  readonly detail: string;
}

/**
 * Raised when the writer refuses an event, carrying the same information a
 * returned {@link SyncFailure} does.
 *
 * `persistCanonicalEvents` throws it so a direct caller cannot silently lose a
 * write; `syncSource` catches it and reports it as a {@link SyncFailure} on the
 * result, so the user-facing loop answers with a typed outcome instead of an
 * exception escaping a route handler as an opaque 500.
 */
export class SyncPersistenceError extends Error {
  override readonly name = "SyncPersistenceError";

  readonly failure: SyncFailure;

  constructor(failure: SyncFailure) {
    super(
      `event ${JSON.stringify(failure.eventId ?? null)} at position ` +
        `${failure.index ?? null} was refused by the canonical_events writer ` +
        `(${failure.code}): ` +
        failure.detail,
    );
    this.failure = failure;
    Object.setPrototypeOf(this, SyncPersistenceError.prototype);
  }
}

export interface SourceRegistryOptions {
  /** `owner/name` of the repository to read. Required. */
  readonly repository: string;
  /**
   * The HTTP seam. Injected by tests; production leaves it unset and gets the
   * `fetch`-backed transport built here at the composition root.
   */
  readonly transport?: HttpTransport;
  /** Overrides the provider API root (e.g. a self-hosted instance). */
  readonly apiRoot?: string;
  /**
   * Environment reader handed to the core credential factory. Injected by tests
   * so the real `env` source can be exercised without touching `process.env`
   * and without a real token ever existing.
   */
  readonly readEnv?: EnvReader;
  /** Items requested per page. Defaults to the plugin's own default. */
  readonly pageSize?: number;
  /**
   * Further already-constructed plugins to register alongside the GitHub one.
   *
   * Exists so the registry's multi-source capability can be proved without a
   * second concrete plugin existing yet. It takes constructed instances, never
   * module paths, so adding a source is still an explicit static decision here.
   */
  readonly additionalPlugins?: readonly RegisteredPlugin[];
}

/**
 * The credential provider this composition root gives to a source plugin.
 *
 * The source is passed EXPLICITLY as `env` and there is no `fake` option, so the
 * test-only credential source that `createCredentialProvider` guards behind
 * `allowTestSources` is unreachable from this module by construction: there is
 * no parameter through which a caller could ask for it. Tests exercise this
 * same production path by injecting {@link EnvReader} instead.
 */
function credentialProviderFor(
  readEnv: EnvReader | undefined,
): ReturnType<typeof createCredentialProvider> {
  return createCredentialProvider("env", {
    // The token shape belongs to the plugin that owns the wire format, so it
    // is passed in from there rather than defaulted here or held in core.
    profile: GITHUB_TOKEN_PROFILE,
    ...(readEnv === undefined ? {} : { env: { readEnv } }),
  });
}

/**
 * Build a {@link PluginRegistry} holding the GitHub source plugin.
 *
 * The list is static and explicit: the registry is handed already-constructed
 * instances and never resolves a module itself, so importing this module cannot
 * pull in anything that was not already named here.
 */
export function createSourceRegistry(
  options: SourceRegistryOptions,
): PluginRegistry {
  const transport = options.transport ?? fetchTransportOrThrow(options.apiRoot);
  const github = new GitHubSourcePlugin({
    transport,
    credentials: credentialProviderFor(options.readEnv),
    repository: options.repository,
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  return new PluginRegistry([github, ...(options.additionalPlugins ?? [])]);
}

function fetchTransportOrThrow(apiRoot: string | undefined): HttpTransport {
  try {
    return createFetchTransport(apiRoot === undefined ? {} : { apiRoot });
  } catch {
    // The transport's own error names no secret (it has none), but the reason
    // is fixed here so this module's error surface stays a closed set.
    throw new SourceConfigurationError(
      SOURCE_CONFIGURATION_REASONS.transportUnavailable,
    );
  }
}

let singleton: PluginRegistry | undefined;

/**
 * The process-wide registry, built on first use from configuration.
 *
 * Lazy on purpose: building the registry constructs the `fetch` transport, and
 * a module that touched the network stack at import time would make merely
 * importing this file environment-dependent.
 *
 * Passing `options` bypasses the memo so a test can build a differently
 * configured registry without mutating the shared one.
 */
export function getSourceRegistry(
  options?: SourceRegistryOptions,
): PluginRegistry {
  if (options !== undefined) return createSourceRegistry(options);
  if (singleton !== undefined) return singleton;

  const repository = process.env[REPOSITORY_ENV_VAR];
  if (repository === undefined || repository === "") {
    throw new SourceConfigurationError(
      SOURCE_CONFIGURATION_REASONS.repositoryUnset,
    );
  }
  singleton = createSourceRegistry({ repository });
  return singleton;
}

/**
 * Resolves one plugin by name, or throws a fixed-reason error.
 *
 * `PluginRegistry.get` deliberately returns a typed result rather than throwing;
 * this is the one place that turns a miss into an exception, so callers
 * downstream of here do not each re-implement the check.
 */
export function requireSource(
  registry: PluginRegistry,
  name: string,
): RegisteredPlugin {
  const result = registry.get(name);
  if (!result.ok) {
    throw new SourceConfigurationError(
      SOURCE_CONFIGURATION_REASONS.unknownSource,
    );
  }
  return result.value;
}

/**
 * One fetched page, mapped to canonical events.
 *
 * `nextCursor` is carried rather than dropped. The plugin's `FetchedPage`
 * already returns it, and it is the ONLY way past the first page: a cursor is
 * never derivable from the events themselves, so a caller that discards it has
 * no way to reach anything older. Returning it beside the events is what makes
 * {@link syncSource}'s `SyncOptions.cursor` reachable at all -- before this,
 * no call site in the module ever produced a value for that field.
 */
export interface CanonicalEventPage {
  /** The page's events, mapped, in source order. */
  readonly events: CanonicalEvent[];
  /**
   * Opaque cursor for the next page, or `undefined` when the source is
   * exhausted. Opaque to core: hand it back to `fetchCanonicalEvents` /
   * {@link SyncOptions.cursor} unchanged.
   */
  readonly nextCursor?: string;
}

/**
 * Fetch ONE page through a registered source and map it to canonical events.
 *
 * The plugin's native item type is erased by the registry, so the items are
 * handed straight back to the same plugin's `mapToCanonicalEvents` without this
 * module ever inspecting one. Nothing provider-shaped crosses here.
 *
 * ONE PAGE, NOT THE WHOLE SOURCE. The plugin decides page size, and this
 * function does not loop: an unbounded loop here would make a single call's
 * cost unknowable and would page a source forever on a bug. The caller drives
 * the walk instead -- see {@link SyncResult.nextCursor} and
 * {@link syncSourceAllPages}.
 */
export async function fetchCanonicalEvents(
  registry: PluginRegistry,
  name: string = SOURCE_NAME,
  cursor?: string,
): Promise<CanonicalEventPage> {
  const plugin = requireSource(registry, name);
  const page = await plugin.fetchItems(cursor);
  const events = plugin.mapToCanonicalEvents(page.items);
  return page.nextCursor === undefined
    ? { events }
    : { events, nextCursor: page.nextCursor };
}

/**
 * The narrow slice of a Drizzle database this module needs.
 *
 * Structural rather than the full `Database` type so a test can supply a
 * recording fake and assert exactly which rows would have been written. The real
 * client returned by `getDb()` satisfies it, which `bun run typecheck` pins:
 * `getDb()` is used here as the fallback target, so if the two ever diverge the
 * build turns red rather than the insert failing at run time.
 *
 * `onConflictDoUpdate` is part of the seam because the upsert below is not an
 * optional nicety: without it this type would describe a plain insert, and a
 * test fake could accept rows while production raised 23505. `set` is typed
 * against the real Drizzle config bound to the real table, so the update column
 * list is checked at compile time against `canonical_events` rather than by
 * inspection — see {@link UpsertSetClause} for the annotation that carries the
 * check, since the `set` position alone does not.
 */
export interface CanonicalEventWriter {
  insert(table: typeof canonicalEvents): {
    values(rows: NewCanonicalEventRow[]): CanonicalEventUpsertBuilder;
  };
}

/**
 * The insert this module actually performs, named so the seam below can be typed
 * against the REAL table instead of Drizzle's deliberately unconstrained
 * `AnyPgInsert` alias.
 *
 * `AnyPgInsert` is `PgInsertBase<any, any, any, any, any, any>`, so a config
 * generic over it resolves `set` to `PgUpdateSetSource<any>` — a string-keyed map
 * that accepts any column name at all. Pinning the table here is what makes the
 * conflict clause name real columns.
 */
type CanonicalEventInsert = PgInsert<typeof canonicalEvents>;

/**
 * Drizzle's own conflict config, bound to the real insert. So `set` resolves to
 * `PgUpdateSetSource<typeof canonicalEvents>`: keys are `canonical_events`
 * columns and values are that column's data type, `SQL` or `PgColumn`.
 */
export type CanonicalEventConflictConfig =
  PgInsertOnConflictDoUpdateConfig<CanonicalEventInsert>;

/** Every column name `canonical_events` can carry, per Drizzle's own `set` type. */
type CanonicalEventColumn = keyof CanonicalEventConflictConfig["set"] & string;

/**
 * The natural key, which an update on a natural-key conflict MUST NOT rewrite.
 *
 * `id` is the PRIMARY key: reassigning it orphans anything referencing the row,
 * and the upsert's whole meaning is that the existing row is the same entity,
 * updated — not replaced by a new one. `source` and `externalId` are the rest of
 * `UNIQUE(source, external_id)`; rewriting either moves the row out from under
 * its own conflict target.
 */
type NaturalKeyColumn = "id" | "source" | "externalId";

/**
 * The columns an upsert on a natural-key conflict is allowed to update.
 *
 * DERIVED FROM THE SCHEMA, then narrowed: `Exclude` over the real column names
 * rather than a hand-copied list, so a column added to `db/schema.ts` becomes
 * updatable automatically (and stays unwritten until deliberately added to
 * {@link UPSERT_UPDATED_COLUMNS}) while a column REMOVED from the schema turns
 * the list here into a compile error instead of a silent runtime failure.
 */
type UpdatableColumn = Exclude<CanonicalEventColumn, NaturalKeyColumn>;

/**
 * The shape {@link UPSERT_UPDATED_COLUMNS} must have.
 *
 * All-optional, matching Drizzle's own `set`: an update need not touch every
 * column. Every key optional AND every key excluded from the natural key, so
 * BOTH failure modes the list's docstring warns about are compile errors.
 *
 * This is what makes the guarantee real. `set` cannot enforce it on its own:
 * TypeScript's excess-property check applies only to a FRESH object literal, and
 * the call site passes an already-evaluated `const`, so a misspelled key in that
 * `const` would reach Drizzle unchecked. The annotation on the constant is where
 * the check actually lands.
 *
 * NOTE THE SPLIT IN WHAT EACH LAYER CATCHES, because it is not symmetric. This
 * type is Drizzle's `set` MINUS the natural key, so it rejects `id`, `source` and
 * `externalId`. It does not need to be Drizzle's own `set` for that — but it also
 * must not be narrowed ANY further, because Drizzle's `set` is what rejects a
 * misspelled column in the first place, and that is the part
 * {@link CanonicalEventConflictConfig} supplies. Neither type alone is the
 * guarantee; this one is where the natural key is excluded and the seam is where
 * the column names are checked, and the constant is annotated with BOTH.
 *
 * Exported so the type-level regression test can assert the natural-key
 * exclusions directly instead of inferring them from the constant's value.
 */
export type UpsertSetClause = {
  readonly [K in UpdatableColumn]?: CanonicalEventConflictConfig["set"][K];
};

/**
 * The chained half of the insert a persist performs, up to and including the
 * conflict clause.
 *
 * Named separately so {@link CanonicalEventWriter} stays a one-method seam a
 * fake can implement, and so a fake must supply `onConflictDoUpdate` rather than
 * silently dropping the upsert and recording rows that production would reject.
 *
 * The config is Drizzle's OWN `PgInsertOnConflictDoUpdateConfig`, not an
 * invented structural copy: `set` legitimately holds either a bound value or an
 * `excluded.<column>` SQL fragment (an update has no access to the row object),
 * and `target` holds table columns. Re-declaring those as plain `string`/`Date`
 * here is what makes a hand-written seam drift from what `getDb()` actually
 * accepts — and `bun run typecheck` pins that `getDb()` still satisfies this
 * interface, so the two cannot diverge silently.
 *
 * THE TYPE PARAMETER IS THE REAL TABLE, NOT `AnyPgInsert`, so `set` is keyed by
 * `canonical_events`'s actual columns and a misspelled one is a compile error
 * here as well as at the constant. Note what this does NOT do on its own: `id`,
 * `source` and `externalId` ARE legal `set` keys to Drizzle, so the natural-key
 * exclusion lives in {@link UpsertSetClause} and not in this seam. What this costs
 * the fake-implementation use case: nothing. A fake never has to mention the
 * schema, because TypeScript checks METHOD PARAMETERS bivariantly — a fake
 * declaring `onConflictDoUpdate(config: { target: unknown; set: Record<string,
 * unknown> })` still satisfies this interface, which is exactly how
 * `__tests__/composition-root.test.ts`'s `RecordingWriter` is written. The
 * constraint binds the PRODUCTION call site, which is where the misspelling
 * would be, and leaves the recording fake free to accept anything.
 */
export interface CanonicalEventUpsertBuilder {
  onConflictDoUpdate(
    config: CanonicalEventConflictConfig,
  ): PromiseLike<unknown>;
}

/**
 * The columns an upsert overwrites on a natural-key conflict.
 *
 * EVERY provider-supplied or derived field, enumerated explicitly rather than
 * derived, for two reasons.
 *
 * 1. `id`, `source` and `externalId` are the natural key and MUST NOT appear
 *    here. `id` in particular is the primary key: rewriting it would orphan
 *    anything that references the row, and the whole point of the upsert is that
 *    the existing row is the same entity, updated — not replaced by a new one.
 * 2. A `set` that is derived from the row (e.g. spreading every column) would
 *    silently re-assign `id` the moment someone adds a column to the schema,
 *    which is failure (2) arriving invisibly. Enumerating the list means a new
 *    column is NOT written until it is deliberately added here, and the type
 *    error names exactly what was missed.
 *
 * `type`, `title`, `url`, `author`, `metadata` and `occurredAt` are the mutable
 * description of the event: a source may edit a title, correct a timestamp, or
 * drop an author, and a re-sync must be able to converge on the source's current
 * view rather than freezing the first sighting forever.
 *
 * BOTH PROMISES ABOVE ARE NOW ENFORCED BY THE `: UpsertSetClause` ANNOTATION,
 * which was added with these claims already in place and the type not delivering
 * them. The annotation is Drizzle's `set` (bound to the real table, which is what
 * rejects a misspelling like `occurred_at` — the SQL name, not the Drizzle
 * property) MINUS the natural key (which is what rejects naming `id`). The
 * annotation is load-bearing: removing it and restoring the bare `as const`
 * reproduces a `typecheck` that passes at exit 0 with both mistakes present, and
 * `__tests__/upsert-set-clause.types.ts` re-proves that by `tsc`.
 */
const UPSERT_UPDATED_COLUMNS: UpsertSetClause = {
  type: sql`excluded.type`,
  title: sql`excluded.title`,
  url: sql`excluded.url`,
  author: sql`excluded.author`,
  metadata: sql`excluded.metadata`,
  occurredAt: sql`excluded.occurred_at`,
};

/**
 * Persist canonical events to the `canonical_events` table.
 *
 * Only fields the `CanonicalEvent` contract defines are written: the mapping to
 * row shape is `db/canonical-event-mapper.ts`'s job, which is the type↔storage
 * boundary and knows every column. No column is named here, so this module
 * cannot drift from the schema or invent a field.
 *
 * IDEMPOTENT. This is an UPSERT on the natural key `UNIQUE(source, external_id)`
 * — `canonical_events_source_external_id_key`, the constraint `db/schema.ts`
 * documents as existing precisely so this upsert cannot silently double-write.
 * Re-persisting the same event UPDATES the existing row instead of raising
 * SQLSTATE 23505, so syncing the same repository twice is a success, not a
 * failure. This is the single most likely caller behaviour for a sync pipeline.
 *
 * WHY THE ARBITER IS THE TWO-COLUMN CONSTRAINT AND NOT `id`. The natural key
 * is `UNIQUE(source, external_id)`, NOT the primary key `id`, so targeting `id`
 * would leave the duplicate-key failure in place for every real repeat sync
 * while looking like an idempotency fix. `id` is derived from `source` +
 * `externalId` today, so in practice a repeat sync collides on BOTH indexes;
 * Postgres resolves the conflict against the arbiter named here, and
 * `src/app/sources/__tests__/persist-canonical-events-upsert.test.ts` proves the
 * behaviour by execution against a real database: a changed title updates one
 * row; the same `externalId` under a different `source` yields two rows; and a
 * row colliding on `id` ALONE raises 23505 instead of overwriting an unrelated
 * event, which is the case a primary-key arbiter would silently absorb.
 *
 * WHAT STILL REACHES 23505 AFTER THIS CHANGE. The upsert absorbs duplicates of
 * the natural key, so a repeat sync of the same repository succeeds. It does
 * NOT make duplicates impossible: a row whose `id` collides while its
 * (source, external_id) does not is invisible to `ON CONFLICT`, and the primary
 * key raises 23505. A caller must therefore still handle 23505 as a genuine,
 * reachable failure — it means "these are two different events claiming one
 * primary key", which is a conflict to report, not an idempotent retry.
 *
 * An empty list is a no-op rather than a query: a source that has nothing new
 * must not cost a round trip, and Drizzle rejects an empty `values()`.
 *
 * WHY THE BATCH IS DEDUPLICATED BEFORE `.values()`. `ON CONFLICT DO UPDATE`
 * absorbs a duplicate that ALREADY EXISTS in the table. It cannot absorb two
 * duplicates of the SAME key WITHIN ONE STATEMENT: Postgres refuses to update
 * the same conflict row twice in a single command and raises SQLSTATE 21000
 * (`cardinality_violation`), which aborts the whole statement. The batch is
 * therefore not partially lost, it is ENTIRELY lost — measured against a real
 * Postgres at this head, a batch containing a repeated `(source, external_id)`
 * raised 21000 and left zero rows behind while a control batch through the same
 * writer succeeded, so the table was provably writable. That failure is silent
 * at the level the only production caller sees: `syncSource`'s caller in T15's
 * route handler cannot distinguish "this batch collided with itself" from "this
 * source had nothing new", both of which look like nothing persisted.
 *
 * So the duplicate is removed from the batch rather than left for Postgres to
 * reject. See {@link dedupeByNaturalKey} for which of two conflicting payloads
 * survives.
 *
 * THE MAP IS GUARDED, and this is the fix for a layer disagreement. The domain's
 * `isIso8601DateTime` accepts any fractional-digit count — deliberately, because
 * a sub-millisecond instant is still orderable, and narrowing it to what a
 * `timestamptz` bind survives would be re-deciding the domain's validity rule
 * from the storage layer. The WRITER then refuses to silently truncate it. Both
 * answers are right, so the disagreement is not resolved here by changing either
 * one: `toCanonicalEventRow` is called one event at a time and its rejection is
 * converted into a {@link SyncPersistenceError} that names the refused event.
 * Nothing is written when any event is refused — the batch is all-or-nothing, so
 * a partial write could not be reported as a success.
 *
 * @returns how many rows were written.
 * @throws SyncPersistenceError if the writer refuses any event, carrying the
 * writer's own rejection message verbatim.
 */
export async function persistCanonicalEvents(
  events: readonly CanonicalEvent[],
  writer?: CanonicalEventWriter,
): Promise<number> {
  if (events.length === 0) return 0;
  // Mapping happens FIRST and deduplication SECOND, deliberately. Mapping first
  // keeps `SyncFailure.index` a true position in the page the caller fetched;
  // deduplicating first would renumber every event after the first duplicate,
  // so a refusal would point at the wrong item. The dedupe still happens before
  // `.values()`, which is where the cardinality violation is raised.
  const rows = dedupeByNaturalKey(mapRows(events));
  // Resolved INSIDE the guard rather than as a default parameter value: a
  // default is evaluated on every call, including when a writer is supplied, so
  // `writer = getDb()` would demand DATABASE_URL from a caller that never
  // touches the database at all.
  await (writer ?? getDb())
    .insert(canonicalEvents)
    .values(rows)
    .onConflictDoUpdate({
      target: [canonicalEvents.source, canonicalEvents.externalId],
      set: UPSERT_UPDATED_COLUMNS,
    });
  return rows.length;
}

/**
 * Map every event to its row, or throw the FIRST refusal as a classified
 * {@link SyncPersistenceError}.
 *
 * Per-event rather than one `events.map(toCanonicalEventRow)`, so the refused
 * event's index and ids are known. The FIRST rejection is reported, not an
 * aggregate: the writer stops at the first, and collecting all of them would
 * mean re-running the mapper to enumerate — pointless, since a page that has one
 * unusable instant has a data problem the caller must fix upstream, and fixing
 * it is what makes the rest of the page writable.
 *
 * Only a `TypeError` is classified. Anything else from this call is a bug in
 * this module or in the mapper's internals, and is left to propagate rather than
 * being laundered into a "the event was refused" answer that would be a lie.
 */
function mapRows(events: readonly CanonicalEvent[]): CanonicalEventRow[] {
  const rows: CanonicalEventRow[] = [];
  for (const [index, event] of events.entries()) {
    try {
      rows.push(toCanonicalEventRow(event));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new SyncPersistenceError({
        code: SYNC_FAILURE_CODES.eventNotPersistable,
        scope: SYNC_FAILURE_SCOPES.event,
        index,
        eventId: event.id,
        externalId: event.externalId,
        detail: error.message,
      });
    }
  }
  return rows;
}

/**
 * Collapse rows sharing the natural key `UNIQUE(source, external_id)`, keeping
 * the LAST occurrence of each key.
 *
 * WHY THE DEDUPE IS NECESSARY. `ON CONFLICT DO UPDATE` resolves a conflict
 * against a row that ALREADY EXISTS in the table. Two rows in ONE statement
 * that both target the SAME conflict row is a different thing: Postgres raises
 * SQLSTATE 21000 (`cardinality_violation`, "cannot update row more than once")
 * and the statement aborts, so the WHOLE batch is written zero rows rather than
 * one — the failure mode this function exists to remove. Measured on a real
 * Postgres: a batch with one repeated natural key raised 21000 and left no rows
 * behind, while a control batch through the same writer succeeded. `syncSource`
 * reports both as `persisted: 0`, which is why the loss was silent.
 *
 * WHICH EVENT WINS: LAST OCCURRENCE WINS, stated explicitly rather than left
 * emergent. If the batch names `(source, externalId)` more than once, the LAST
 * such row in input order is kept and every earlier one is dropped. The reason
 * last-wins: this function's whole purpose is to converge on the source's
 * CURRENT view of an event — the upsert's own rule is that a repeat sync
 * UPDATES the mutable columns (see {@link UPSERT_UPDATED_COLUMNS}) — and within
 * one fetched page a later sighting of the same event is at least as fresh as an
 * earlier one, exactly as a later sync overwrites an earlier sync. A page is
 * ordered by the source, so "later in the batch" is the source's own ordering,
 * not an accident of iteration.
 *
 * DETERMINISM. The rule is positional and total: for every input position there
 * is exactly one decision (keep if no later row shares its key), so the result
 * does not depend on object identity, property enumeration order, or Map
 * insertion/re-insertion order. Each key is seen once in `kept`, and a later
 * occurrence REPLACES the earlier one, so the surviving row is the last one by
 * construction. `Map` never reorders an existing key when its value is
 * replaced, and the key is the JSON-encoded PAIR rather than a delimiter-joined
 * string, so no two distinct natural keys can be forged into one.
 *
 * THE KEY IS THE PAIR `(source, externalId)`, NOT EITHER COLUMN ALONE. `source`
 * participates in the key because it is part of the constraint the upsert
 * targets: the same `externalId` under two sources is two DIFFERENT events and
 * both must survive. `id` deliberately does NOT participate: a primary-key
 * collision that the natural key does not share is a genuine conflict for the
 * database to raise (23505), and absorbing it here would hide two different
 * events claiming one primary key. Deduplication must not weaken that path, and
 * `__tests__/persist-canonical-events-upsert.test.ts` pins both halves.
 */
function dedupeByNaturalKey(
  rows: readonly CanonicalEventRow[],
): CanonicalEventRow[] {
  const kept = new Map<string, CanonicalEventRow>();
  for (const row of rows) {
    // `JSON.stringify` of the pair, not a delimiter join: a delimiter can appear
    // inside either value, so `("a|b", "c")` and `("a", "b|c")` would forge one
    // key out of two distinct natural keys and silently drop an event. The JSON
    // array is unambiguous for every string, so no key is ever forged.
    kept.set(JSON.stringify([row.source, row.externalId]), row);
  }
  // Map iteration order is insertion order, and `set` on an EXISTING key
  // replaces the value without moving the key, so this yields one row per
  // natural key in the position of that key's FIRST occurrence in the batch,
  // holding that key's LAST occurrence. Row order is irrelevant to the outcome
  // (keys are independent) but keeping it stable makes a failure reproducible
  // instead of dependent on a Map's internals.
  return [...kept.values()];
}

/**
 * Postgres check-violation SQLSTATE, in its numeric form.
 *
 * 23514 is the whole of class 23 (`integrity_constraint_violation`) that this
 * table uses for CHECK constraints — see `canonical_events_type_check` and
 * `canonical_events_metadata_is_object_check`. The numeric form carries no text
 * in it, so nothing a driver or an attacker controls can reach a response
 * through a comparison against it.
 */
const CHECK_VIOLATION = "23514";

/**
 * Detect a check-constraint violation by walking the cause chain for a
 * SQLSTATE `code`, never for message text.
 *
 * The shape is deliberately identical to `isUniqueViolation` in the sync route,
 * for the same reason and with the same two properties: the discriminator is the
 * five-character numeric SQLSTATE, so no attacker-influenced driver text is ever
 * parsed, and the walk is depth-bounded so a cyclic cause chain cannot hang the
 * sync. Drizzle wraps driver failures, so the code lives on `cause` one or more
 * levels down.
 *
 * WHY A NUMERIC SQLSTATE AND NOT THE CONSTRAINT NAME. Naming the constraint
 * would classify better but cannot be done safely: the constraint name reaches
 * us inside the driver's own message, and this module's contract is that no
 * driver text is parsed. Two check constraints exist on this table today
 * (`type` and `metadata`) and both mean exactly one thing here — the batch is
 * not persistable — so the coarser classifier gives the same correct answer for
 * both, and gives it for any check constraint added later without a code change.
 */
function isCheckViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ((current as { code?: unknown }).code === CHECK_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface SyncOptions {
  readonly registry: PluginRegistry;
  /** Registered plugin name. Defaults to the GitHub plugin's own name. */
  readonly source?: string;
  /**
   * Opaque cursor from a previous call, to resume where that call stopped.
   * Produced by a previous call's {@link SyncResult.nextCursor}. `undefined`
   * starts at the source's newest page.
   */
  readonly cursor?: string;
  /** Persistence target. Defaults to the real Drizzle client. */
  readonly writer?: CanonicalEventWriter;
}

/**
 * The outcome of syncing ONE page: what was written, and whether there is more.
 *
 * `failure` AND `nextCursor` ARE NOT IN TENSION, and which one is present is
 * not inferable from the type -- so the three states are enumerated here and
 * pinned by tests in `__tests__/composition-root.test.ts` ("failure and
 * nextCursor are independent"):
 *
 *   | outcome                            | persisted | failure | nextCursor |
 *   |------------------------------------|-----------|---------|------------|
 *   | batch REFUSED                      | 0         | present | ABSENT     |
 *   | successful, source EXHAUSTED        | > 0       | absent  | ABSENT     |
 *   | successful, PARTIAL (more to come)  | > 0       | absent  | present    |
 *
 * WHY A REFUSED BATCH CARRIES NO CURSOR, since that is the one case a caller
 * cannot derive from the rules above. The batch is all-or-nothing, so a refusal
 * wrote NOTHING: every event on that page is still unwritten. Handing back the
 * source's cursor would tell a caller to advance PAST a page it believes is
 * durable, which loses those events permanently and silently. So the cursor is
 * dropped on the refusal path and the caller re-drives the SAME cursor instead,
 * which re-fetches the refused page and retries it once the data is fixed.
 *
 * Consequently `failure` and `nextCursor` are mutually exclusive by
 * construction, and "both present" is not a reachable state rather than an
 * undocumented one.
 */
export interface SyncResult {
  /** The events this sync produced, in source order. */
  readonly events: CanonicalEvent[];
  /** How many rows were written. */
  readonly persisted: number;
  /**
   * Present only when the sync did NOT complete.
   *
   * Absent on success. On refusal it carries the classification AND the
   * writer's own reason, and `persisted` is `0` — the batch is all-or-nothing,
   * so there is no partial count to report.
   */
  readonly failure?: SyncFailure;
  /**
   * Cursor for the NEXT page, or `undefined` when the source is exhausted.
   *
   * This is the pagination contract, stated explicitly: a single `syncSource`
   * call syncs exactly ONE page, and reaching older history means calling again
   * with the cursor this returns. It is `undefined` -- never a stale repeat of
   * the input cursor -- once the source has no more pages, so a caller walking
   * the source terminates rather than looping on the final page forever.
   */
  readonly nextCursor?: string;
}

/**
 * The user-facing loop this card exists to make reachable: fetch work from a
 * source, then persist the canonical events it maps to.
 *
 * A writer refusal is RETURNED, not thrown. This is the boundary half of the
 * fix: a `CanonicalEvent` the domain considers valid can still be one the
 * writer refuses, and that must reach the caller as a typed, actionable outcome
 * rather than an exception escaping to whatever called this — which, once T15
 * makes this a production route handler, is an opaque 500 with no indication of
 * which event or why. Everything else about the sync still throws: a transport
 * or credential failure has no classification to report and is genuinely
 * exceptional.
 *
 * WHAT "THE WRITER REFUSED" COVERS, AND WHY THE CATCH IS NOT `instanceof`-ONLY.
 * `mapRows` raises a `SyncPersistenceError` for a per-event rejection, but the
 * mapper cannot see everything the database enforces: `metadata` is a
 * compile-time claim with no runtime shape check, and the type allow-list is
 * enforced by a CHECK constraint the mapper never sees. A non-object `metadata`
 * and an out-of-list `type` therefore reach Postgres, which refuses the whole
 * statement with SQLSTATE 23514 — and a raw driver error escaping this catch is
 * exactly what produced the two-answers-one-batch defect. Measured against a
 * real Postgres through this function, before the fix:
 *
 *   metadata = [1,2,3] -> thrown out of syncSource -> route 500 internal_error
 *   metadata = null    -> returned as a failure   -> route 422
 *
 * The same refused batch, two answers, and the 500 one is a lie about a data
 * problem. So a driver-thrown 23514 is converted into the SAME classified
 * refusal here, by SQLSTATE and never by message text (see
 * {@link isCheckViolation}).
 *
 * SCOPE, STATED RATHER THAN GUESSED. A database-raised refusal carries no
 * offending row: the batch is one statement, so Postgres names the row it was
 * inserting, not which of several rows tripped a constraint. Inventing an
 * index or an event id there would be a fabricated answer, so the page-scope
 * refusal names no event and says so through `scope`. A caller that needs to
 * know WHICH event was refused re-fetches the page and validates it
 * client-side; the route deliberately reports neither.
 *
 * The all-or-nothing property is preserved and load-bearing: a CHECK refusal
 * aborts the whole statement, so `persisted: 0` is literally true rather than a
 * rounded-down count.
 *
 * ONE PAGE PER CALL. See {@link SyncResult.nextCursor} for the contract and
 * {@link syncSourceAllPages} for the caller that walks the whole source.
 */
export async function syncSource(options: SyncOptions): Promise<SyncResult> {
  const page = await fetchCanonicalEvents(
    options.registry,
    options.source ?? SOURCE_NAME,
    options.cursor,
  );
  // The writer is passed straight through, NOT defaulted here: `options.writer
  // ?? getDb()` is an argument expression, so `getDb()` would be evaluated on
  // every call and demand DATABASE_URL from a caller that has nothing to
  // persist. The callee resolves it inside its own empty-list guard.
  try {
    const persisted = await persistCanonicalEvents(page.events, options.writer);
    return withCursor({ events: page.events, persisted }, page.nextCursor);
  } catch (error) {
    // A REFUSAL CARRIES NO CURSOR, and that is a decision rather than an
    // omission -- see `SyncResult`'s doc comment. `page.nextCursor` is dropped
    // on both refusal paths: the batch was all-or-nothing and NOTHING was
    // written, so advancing past this page would silently skip events the
    // caller believes are now durable. A caller that re-drives the SAME cursor
    // re-fetches the refused page and can retry it once the data is fixed.
    if (error instanceof SyncPersistenceError) {
      return { events: page.events, persisted: 0, failure: error.failure };
    }
    if (isCheckViolation(error)) {
      return {
        events: page.events,
        persisted: 0,
        failure: checkViolationFailure(error),
      };
    }
    throw error;
  }
}

/**
 * Attach `nextCursor` only when the source reported one.
 *
 * OMISSION RATHER THAN `undefined`. An always-present `nextCursor: undefined`
 * key would make `"nextCursor" in result` and `Object.keys()` disagree with
 * what a caller sees, which is the same trap `SyncResult.failure` is documented
 * against: callers branch on `!== undefined`, and a test asserting the key is
 * absent is asserting a stronger and more useful fact than one asserting it
 * reads `undefined`.
 */
function withCursor(
  result: SyncResult,
  nextCursor: string | undefined,
): SyncResult {
  return nextCursor === undefined ? result : { ...result, nextCursor };
}

/** Bound on the page walk, so a source that never reports exhaustion cannot
 * hang the process. Far above any real page count at `PAGE_SIZE = 30`. */
const MAX_SYNC_PAGES = 10_000;

/**
 * The outcome of a walk that reached the source's end.
 *
 * A FOURTH SHAPE, and narrower than {@link SyncResult} on purpose. Where a
 * single `syncSource` call reports one of three states (refused / exhausted /
 * partial), this walk reaches exactly one: every page it fetched was WRITTEN and
 * the source reported no further page. So it carries no `failure` and no
 * `nextCursor` — a refusal aborts the walk by throwing
 * {@link SyncPageRefusedError}, and exhaustion means there is nowhere left to
 * resume. Declaring the optional fields here would let a caller branch on a
 * `failure` that can never be present and on a cursor that can never be
 * meaningful, which is precisely the "which field wins" ambiguity `SyncResult`
 * already has to document.
 */
export interface SyncSourceAllPagesResult {
  /** Every event across every page, in source order. All of it was written. */
  readonly events: CanonicalEvent[];
  /** How many rows were written. Equals `events.length` by construction. */
  readonly persisted: number;
  /** How many pages were fetched and persisted, the empty last one included. */
  readonly pages: number;
}

/**
 * A page in the MIDDLE of a walk was refused, so the walk stopped there.
 *
 * Distinct from a thrown transport or credential failure: this carries the
 * batch-12 classification, and — unlike a first-page refusal, which the caller
 * sees directly from `syncSource` — it happens behind pages that were already
 * written, so the caller cannot tell from anything it already holds that an
 * earlier page succeeded.
 *
 * `cursor` IS THE CURSOR THAT FETCHED THE REFUSED PAGE, not the cursor after
 * it. That is the whole point: the refused page wrote nothing (the batch is
 * all-or-nothing), so re-driving this cursor re-fetches exactly those events
 * and retries them once the data is fixed, while the `pages` already counted
 * stay durable. Advancing instead would silently lose a page.
 */
export class SyncPageRefusedError extends Error {
  /** The classification `syncSource` produced for the refused page. */
  readonly failure: SyncFailure;
  /** Cursor to re-drive to retry the refused page; `undefined` if it was the first. */
  readonly retryCursor: string | undefined;
  /** Pages durably written BEFORE the refusal. */
  readonly pages: number;
  /** Rows durably written before the refusal. */
  readonly persisted: number;

  constructor(
    failure: SyncFailure,
    retryCursor: string | undefined,
    pages: number,
    persisted: number,
  ) {
    super(
      `syncSourceAllPages: page ${pages + 1} was refused (${failure.code}, scope ${failure.scope}) after ${pages} page(s); ${persisted} row(s) remain durable and the refused page is unwritten. Re-drive the same cursor to retry it.`,
    );
    this.name = "SyncPageRefusedError";
    this.failure = failure;
    this.retryCursor = retryCursor;
    this.pages = pages;
    this.persisted = persisted;
  }
}

/**
 * Walk a source from `cursor` to exhaustion, syncing every page.
 *
 * EXISTS BECAUSE ONE PAGE IS NOT A SYNC. With `PAGE_SIZE = 30` and descending
 * order, a single page only ever reaches the newest 30 items, so "ingest the
 * repository's history" was unreachable unless every caller remembered to
 * re-drive the cursor by hand -- and nothing in the module produced a cursor to
 * do that with. This is that loop, written once.
 *
 * THE BOUND IS LOAD-BEARING, not defensive decoration: termination is decided
 * by the plugin reporting no `nextCursor`, and a plugin that keeps reporting one
 * would otherwise loop forever. The walk also throws on a REPEATED cursor,
 * which is the other way a source can fail to advance -- a plugin that returns
 * a constant cursor is paging itself in circles, and silently returning the
 * first page's events once per duplicate would be a silently truncated ingest.
 *
 * A REFUSED PAGE ABORTS THE WALK, AND THAT IS THE POINT. A refusal is reported,
 * not thrown, by `syncSource` — which is right for one page but wrong for the
 * aggregate, because a refusal on any page but the FIRST is invisible from
 * outside: the loop sees a `SyncResult` whose `persisted` is 0 and whose
 * `events` is a full page, and if it kept summing, the aggregate would report
 * `persisted: 2, events.length: 4` and no failure at all. Two events were never
 * written and the caller is told the ingest completed. So the walk stops on the
 * first `page.failure` and throws {@link SyncPageRefusedError} naming the cursor
 * that fetched that page. Returning-throwing keeps the result's one invariant
 * true and unmissable: if this returns, `persisted === events.length`.
 *
 * @throws {RangeError} when `maxPages` is not an integer >= 1.
 * @throws {SyncPageRefusedError} when a page is refused mid-walk, carrying the
 * classification and the cursor to re-drive. Nothing partial is returned in any
 * of these cases: the failure is loud instead.
 */
export async function syncSourceAllPages(
  options: SyncOptions & { readonly maxPages?: number },
): Promise<SyncSourceAllPagesResult> {
  const maxPages = options.maxPages ?? MAX_SYNC_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new RangeError(`syncSourceAllPages: maxPages must be >= 1`);
  }

  const events: CanonicalEvent[] = [];
  const seenCursors = new Set<string>();
  let persisted = 0;
  let pages = 0;
  let cursor = options.cursor;

  for (;;) {
    const page: SyncResult = await syncSource({ ...options, cursor });
    pages += 1;
    // BEFORE anything is accumulated: a refused page contributed nothing
    // durable, so its events must not enter `events` (which would break
    // `persisted === events.length`) and the walk must not advance past it.
    if (page.failure !== undefined) {
      throw new SyncPageRefusedError(
        page.failure,
        cursor,
        pages - 1,
        persisted,
      );
    }
    events.push(...page.events);
    persisted += page.persisted;
    if (page.nextCursor === undefined) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(
        `syncSourceAllPages: source repeated cursor after ${pages} pages; aborting rather than paging in circles`,
      );
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (pages >= maxPages) {
      throw new Error(
        `syncSourceAllPages: exceeded maxPages (${maxPages}) without the source reporting exhaustion; aborting`,
      );
    }
  }

  return { events, persisted, pages };
}

/**
 * The persistence layer's own reason, taken from the DEEPEST link of the cause
 * chain rather than the outermost.
 *
 * WHY DEPTH MATTERS, AND IT IS NOT COSMETIC. Drizzle's own failure is the
 * outermost link and its message is `"Failed query: insert into
 * \"canonical_events\" ..."` — true, and useless: it names no constraint and no
 * offending value, so the caller would learn only that some insert failed. The
 * driver's own message is the link that says WHICH rule fired. `mapRows` already
 * keeps the writer's own reason for a mapper rejection; taking the outermost
 * link here would make the database-raised path carry strictly LESS than the
 * mapped one, which is backwards.
 *
 * The text is still carried VERBATIM — it is selected, never parsed or
 * re-rendered, and no classification anywhere depends on its content. If no
 * link in the chain has a string message, the outermost one's stringification
 * is used rather than an empty detail, so the field is never blank.
 */
function driverMessage(error: unknown): string {
  let deepest = error;
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    if (current instanceof Error) deepest = current;
    current = (current as { cause?: unknown }).cause;
  }
  return deepest instanceof Error ? deepest.message : String(deepest);
}

/**
 * Classify a driver-thrown check violation into the same
 * {@link SyncFailure} the mapper produces.
 *
 * `detail` is the persistence layer's own reason carried VERBATIM, on exactly
 * the same terms as a mapper rejection: it names the rule that refused the
 * batch, which is what makes the refusal actionable to whoever has to fix the
 * data. It is NOT rendered by the route — the sync handler selects the
 * classification into fixed text and drops the detail, so this never reaches a
 * response. That contract is asserted by `handler.test.ts` against a canary,
 * not left to this comment.
 *
 * The code is the ONE existing `SyncFailureCode`: a new outcome was available
 * and was deliberately not taken, because "the batch is not persistable" is the
 * same statement whichever layer refused it, and two codes for it would let the
 * route grow a second, differently-statused answer for the same fact.
 */
function checkViolationFailure(error: unknown): SyncFailure {
  return {
    code: SYNC_FAILURE_CODES.eventNotPersistable,
    scope: SYNC_FAILURE_SCOPES.page,
    detail: driverMessage(error),
  };
}
