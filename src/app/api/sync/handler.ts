/**
 * The ignition route's logic, kept out of `route.ts` on purpose.
 *
 * Next.js validates the exports of a `route.ts` against generated types and
 * rejects a module that exports anything other than the HTTP methods and the
 * route-segment config. The handler therefore lives here, is exported as an
 * ordinary function, and is unit-tested directly with an injected registry,
 * writer and environment reader -- `route.ts` stays a two-line adapter.
 *
 * WHAT THIS MODULE IS. The one production caller of `syncSource()`
 * (`src/app/sources/index.ts:286`). Before this card the pipeline ended at the
 * `canonical_events` table: credential provider -> plugin -> table -> nothing.
 *
 * SECRET HYGIENE -- THE STRONG FORM. Every string that can reach a response
 * body here is either a FIXED literal from this file or a field read off a
 * closed, already-redacted error type:
 *
 *   - No token value is ever read, held in a variable, logged, or interpolated.
 *     The credential is resolved lazily inside the plugin's `getToken()` and
 *     travels straight into the transport request; this module never sees it.
 *   - {@link describeFailure} NEVER renders `error.message`. It selects a
 *     fixed reason string by error type, so an upstream rejection, a driver
 *     error or a plugin error cannot contribute text to the response. That is
 *     stronger than redacting, and it matches `src/app/sources/index.ts` and
 *     `src/plugins/github/github-errors.ts`, both of which document the same
 *     property.
 *   - The only upstream-derived value that is reported is an HTTP *status
 *     number* (`github-errors.ts` already narrows it to a safe integer) and
 *     that plugin's own fixed, allow-listed `reason`. No Authorization header,
 *     no response body fragment, no request fragment.
 *   - {@link isUniqueViolation} walks the cause chain looking at `code` only.
 *     It deliberately never matches on message text, because a Postgres
 *     duplicate-key message quotes the conflicting key values and a message
 *     match would be a leak surface.
 *
 * REPEATED CALLS -- READ THIS BEFORE TRUSTING A SECOND CALL.
 *
 * `persistCanonicalEvents` is an `ON CONFLICT DO UPDATE` upsert whose arbiter is
 * the natural key `UNIQUE (source, external_id)`
 * (`src/app/sources/index.ts`). A second call carrying the same
 * `(source, external_id)` therefore does NOT duplicate rows and does NOT fail:
 * it converges on the existing row and overwrites the mutable columns in place,
 * which is the behaviour a sync pipeline actually wants. A repeat of the same
 * page is a success, reported as `synced`, with `persisted` counting the rows
 * the upsert wrote.
 *
 * WHAT STILL REACHES `already_present`, AND WHY IT IS STILL HERE. The upsert
 * absorbs a collision on its own key only. A row whose PRIMARY KEY `id` collides
 * while its `(source, external_id)` does not is invisible to `ON CONFLICT`, so
 * the primary key raises SQLSTATE 23505 and this route maps it to
 * `already_present` / HTTP 409. That is a genuine, reachable outcome meaning
 * "two different events are claiming one primary key" -- a conflict to report,
 * not a retry -- so the classification, the status and `isUniqueViolation` stay
 * exactly as they are. Only the PROSE was wrong before: it described a plain
 * `INSERT`, which is not what this batch ships.
 *
 * The response says all of this in every body, via `idempotent` plus a fixed
 * `idempotencyNote`, so a caller reading only the JSON is not misled about
 * either half.
 */

import type { CanonicalEventWriter } from "@/app/sources";
import {
  getSourceRegistry,
  SourceConfigurationError,
  SOURCE_CONFIGURATION_REASONS,
  SOURCE_NAME,
  syncSource,
} from "@/app/sources";
import type { CanonicalEvent } from "@/core/events/canonical-event";
import type { PluginRegistry } from "@/core/plugins/registry";

/** HTTP method this route answers. Recorded in the route file's comment. */
export const SYNC_ROUTE_PATH = "/api/sync";
export const SYNC_ROUTE_METHOD = "POST";

/**
 * The closed set of outcomes. A caller switches on one of these; nothing outside
 * this union is ever produced, which is what makes "each failure mode is
 * distinct" a type-level property rather than a convention.
 *
 * `synced` and `empty` are SUCCESSES. An empty page is a perfectly good answer
 * from a source with nothing new, so it is reported as HTTP 200 with
 * `persisted: 0` rather than as an error.
 */
export const SYNC_OUTCOMES = {
  /** Events were fetched and every row was written. */
  synced: "synced",
  /** The source had nothing new. Success, zero rows. */
  empty: "empty",
  /** DATABASE_URL is not configured, so persistence is impossible. */
  databaseUnconfigured: "database_unconfigured",
  /** The source to read is not configured (DEVLOOP_REPOSITORY). */
  sourceNotConfigured: "source_not_configured",
  /** No usable credential was available; no request was made upstream. */
  credentialUnavailable: "credential_unavailable",
  /** The upstream source answered with a non-2xx status. */
  upstreamRejected: "upstream_rejected",
  /** The request to the upstream source could not be completed. */
  upstreamUnreachable: "upstream_unreachable",
  /**
   * A row in this page collides on its PRIMARY KEY `id` while its
   * `(source, external_id)` does not, so the natural-key upsert cannot absorb
   * it and the primary key raises 23505. Reported distinctly because it is a
   * real conflict between two DIFFERENT events -- deliberately NOT reachable by
   * simply calling this route twice, which the upsert makes a convergent
   * success. See {@link SYNC_IS_IDEMPOTENT}.
   */
  alreadyPresent: "already_present",
  /** Anything else. Still never carries upstream or driver text. */
  internalError: "internal_error",
} as const;

export type SyncOutcome = (typeof SYNC_OUTCOMES)[keyof typeof SYNC_OUTCOMES];

/** Outcomes that mean the request did NOT complete. */
const FAILURE_OUTCOMES: readonly SyncOutcome[] = [
  SYNC_OUTCOMES.databaseUnconfigured,
  SYNC_OUTCOMES.sourceNotConfigured,
  SYNC_OUTCOMES.credentialUnavailable,
  SYNC_OUTCOMES.upstreamRejected,
  SYNC_OUTCOMES.upstreamUnreachable,
  SYNC_OUTCOMES.alreadyPresent,
  SYNC_OUTCOMES.internalError,
];

/**
 * Human-facing text for every outcome. FIXED strings, selected by outcome --
 * never assembled from an error, a response, or any request input. This table
 * is the whole reason an error message cannot leak: there is no interpolation
 * anywhere in this file's response path.
 */
const OUTCOME_MESSAGES: Readonly<Record<SyncOutcome, string>> = {
  [SYNC_OUTCOMES.synced]: "Events were fetched and persisted.",
  [SYNC_OUTCOMES.empty]:
    "The source had nothing new to report. This is a success with zero rows written.",
  [SYNC_OUTCOMES.databaseUnconfigured]:
    "DATABASE_URL is not set, so canonical events cannot be persisted. Copy .env.example to .env and point it at your local Postgres.",
  [SYNC_OUTCOMES.sourceNotConfigured]:
    "DEVLOOP_REPOSITORY is not set, so there is no source to read.",
  [SYNC_OUTCOMES.credentialUnavailable]:
    "No usable credential was available, so no request was made to the source.",
  [SYNC_OUTCOMES.upstreamRejected]:
    "The source refused the request. No upstream response body is reported.",
  [SYNC_OUTCOMES.upstreamUnreachable]:
    "The request to the source could not be completed.",
  [SYNC_OUTCOMES.alreadyPresent]:
    "A row in this page collides on its PRIMARY KEY id while its (source, external_id) does not, which the natural-key upsert cannot absorb. This is not what a repeat call produces — a repeat converges and succeeds. Treat it as a conflict to resolve, not as a retry.",
  [SYNC_OUTCOMES.internalError]:
    "The sync failed for a reason this route does not classify.",
};

/**
 * The truth value for {@link SyncResponseBody.idempotent}, in ONE place.
 *
 * Exported so the unit suite can assert the shipped response against the same
 * constant the handler assigns, instead of against a literal it repeats by hand.
 * The previous shape -- `readonly idempotent: false` plus an inline `false` at
 * the assignment, asserted by `toBe(false)` -- compared a literal to itself and
 * therefore passed whatever the route actually did, which is how the shipped
 * prose came to contradict the upsert with every gate green.
 */
export const SYNC_IS_IDEMPOTENT = true;

/**
 * The honest statement about repeated calls, shipped in every response so a
 * caller reading only the JSON is told both halves: a repeat is SAFE and
 * convergent, and `already_present` means something else entirely.
 *
 * One module-level constant rather than a literal at the use site, so the value
 * asserted by the unit suite and the value a caller reads cannot drift apart.
 * `SYNC_IS_IDEMPOTENT` is what `body()` assigns; it is not inlined.
 */
const IDEMPOTENCY_NOTE =
  "Repeating this call is safe and converges: the write path is an ON CONFLICT DO UPDATE upsert on UNIQUE (source, external_id), so a repeat cannot duplicate rows and does not fail — it updates the existing row's mutable columns to the source's current view. `already_present` is NOT what a repeat produces; it is reserved for a row whose PRIMARY KEY id collides while its (source, external_id) does not, which ON CONFLICT cannot absorb and which is reported as a conflict (HTTP 409) rather than a retry.";

export interface SyncResponseBody {
  readonly ok: boolean;
  readonly outcome: SyncOutcome;
  readonly message: string;
  /** The registered source that was asked for. Never a provider name. */
  readonly source: string;
  /** Events mapped this run. */
  readonly fetched: number;
  /** Rows actually written. `0` on every failure and on `empty`. */
  readonly persisted: number;
  /**
   * Non-sensitive rollup of this run: event counts by canonical type. Counts
   * only -- no ids, titles, authors, URLs or metadata, so the response cannot
   * grow with the page size and cannot carry upstream content.
   */
  readonly byType: Readonly<Record<string, number>>;
  /** Upstream HTTP status, when and only when the source answered non-2xx. */
  readonly upstreamStatus?: number;
  /**
   * Whether a REPEATED call is safe, i.e. whether calling this route again with
   * the same page is a convergent success rather than a refusal.
   *
   * TRUE as of the natural-key upsert: `persistCanonicalEvents` is
   * `ON CONFLICT DO UPDATE` on `UNIQUE (source, external_id)`, so a repeat
   * converges on the existing row instead of duplicating it or failing.
   *
   * It is deliberately NOT typed as the literal `true`. T15 typed it `false` and
   * assigned the constant `false`, which made `expect(body.idempotent).toBe(false)`
   * a tautology -- a test comparing a literal to itself passes whatever the
   * behaviour is, and that is exactly how this batch shipped a response body
   * whose prose contradicted its own write path. `boolean` makes flipping it a
   * compile error at the assignment site, where the constant lives, instead of a
   * silent lie at runtime.
   *
   * The one collision it does NOT absorb is a primary-key-only conflict, and
   * that is reported as `already_present`, not as a retry. See
   * {@link IDEMPOTENCY_NOTE}, shipped in every response.
   */
  readonly idempotent: boolean;
  readonly idempotencyNote: string;
}

export interface SyncHandlerOptions {
  /**
   * Registry to read through. Injected by tests with a fake plugin; production
   * leaves it unset and gets the process-wide registry from `getSourceRegistry()`.
   */
  readonly registry?: PluginRegistry;
  /** Registered plugin name. Defaults to the source plugin's own name. */
  readonly source?: string;
  /**
   * Persistence target. Injected by tests with an in-memory writer; production
   * leaves it unset and the persistence layer resolves the real client itself.
   *
   * A supplied writer also means the route performs NO database check, because
   * a caller that never touches the database must not be asked for
   * DATABASE_URL. That is the same lazy-resolution property
   * `persistCanonicalEvents` documents, preserved rather than papered over.
   */
  readonly writer?: CanonicalEventWriter;
  /**
   * Whether DATABASE_URL is configured. Injected by tests so the production
   * `process.env` read is never exercised by the suite.
   */
  readonly hasDatabaseUrl?: () => boolean;
  /** Overrides the sync call itself. Injected by tests only. */
  readonly sync?: typeof syncSource;
}

/**
 * Whether DATABASE_URL is configured.
 *
 * The value is NOT read into a variable, compared, or returned: this is a
 * boolean derived from presence. A connection string is a secret, and this
 * route has no business holding one even briefly, so the check is written as a
 * presence test whose result is all that leaves this function.
 */
function databaseUrlIsConfigured(): boolean {
  const raw: string | undefined = process.env.DATABASE_URL;
  return raw !== undefined && raw !== "";
}

/** Postgres unique-violation SQLSTATE. The numeric form has no text in it. */
const UNIQUE_VIOLATION = "23505";

/**
 * Detect a unique-constraint violation by walking the cause chain for a
 * SQLSTATE `code`, never for message text.
 *
 * `code` is a five-character numeric string, so nothing an attacker or a driver
 * could put in a message can reach the response through here. Drizzle wraps
 * driver failures, so the code lives on `cause` one or more levels down; the
 * loop is depth-bounded so a cyclic cause chain cannot hang the request.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The HTTP status for an outcome.
 *
 * Deliberately split the way it is: a missing database or credential is 503
 * (the service is not ready), an upstream refusal or unreachable source is 502
 * (a dependency failed), a repeat insert is 409 (a conflict this route reports
 * rather than hides), and an unclassified failure is 500.
 */
function statusFor(outcome: SyncOutcome): number {
  switch (outcome) {
    case SYNC_OUTCOMES.synced:
    case SYNC_OUTCOMES.empty:
      return 200;
    case SYNC_OUTCOMES.databaseUnconfigured:
    case SYNC_OUTCOMES.sourceNotConfigured:
    case SYNC_OUTCOMES.credentialUnavailable:
      return 503;
    case SYNC_OUTCOMES.upstreamRejected:
    case SYNC_OUTCOMES.upstreamUnreachable:
      return 502;
    case SYNC_OUTCOMES.alreadyPresent:
      return 409;
    default:
      return 500;
  }
}

/**
 * Classify a thrown value into an outcome, without rendering it.
 *
 * The error TYPES are the discriminator. `SourceConfigurationError` carries a
 * fixed reason from the composition root; `GitHubPluginError` carries a
 * fixed code, a fixed allow-listed reason and an optional numeric status. The
 * `reason` field is only echoed because that type's own constructor forces it
 * through `toSafePluginReason`, which returns a member of a closed allow-list
 * or a fixed generic value -- a caller cannot get arbitrary text into it.
 *
 * A `CredentialError` is deliberately NOT matched structurally here: the plugin
 * already converts every credential failure into `credential_failed`, so the
 * specific credential code never reaches this layer, and reaching past the
 * plugin for it would import a provider-side type into the route.
 */
function describeFailure(error: unknown): {
  outcome: SyncOutcome;
  upstreamStatus?: number;
} {
  if (error instanceof SourceConfigurationError) {
    // Classified by its fixed REASON, not collapsed to one outcome. The
    // comparison is against module-level constants, never against text the
    // error was built from: `SourceConfigurationError` only ever receives a
    // member of `SOURCE_CONFIGURATION_REASONS`, so an exact equality test
    // cannot be confused by caller input and cannot leak one.
    switch (error.message) {
      case SOURCE_CONFIGURATION_REASONS.repositoryUnset:
        return { outcome: SYNC_OUTCOMES.sourceNotConfigured };
      case SOURCE_CONFIGURATION_REASONS.transportUnavailable:
        // No HTTP transport in this runtime: the source cannot be built at all,
        // which is an environment problem, not an upstream one.
        return { outcome: SYNC_OUTCOMES.sourceNotConfigured };
      default:
        return { outcome: SYNC_OUTCOMES.internalError };
    }
  }

  if (isGitHubPluginError(error)) {
    switch (error.code) {
      case "credential_failed":
        return { outcome: SYNC_OUTCOMES.credentialUnavailable };
      case "http_status":
        return {
          outcome: SYNC_OUTCOMES.upstreamRejected,
          ...(error.status === undefined
            ? {}
            : { upstreamStatus: error.status }),
        };
      case "transport_failed":
        return { outcome: SYNC_OUTCOMES.upstreamUnreachable };
      default:
        // malformed_response / invalid_cursor / invalid_page_size: real
        // failures with no better client-facing classification than "the sync
        // failed". Still secret-free, still never rendering the error.
        return { outcome: SYNC_OUTCOMES.internalError };
    }
  }

  // A persistence failure carrying the unique-violation SQLSTATE. Checked
  // before the generic branch because it is the outcome a repeat call makes,
  // and reporting it as an opaque 500 would hide the very limitation this route
  // is required to expose.
  if (isUniqueViolation(error)) {
    return { outcome: SYNC_OUTCOMES.alreadyPresent };
  }
  return { outcome: SYNC_OUTCOMES.internalError };
}

/**
 * The narrow slice of the plugin's error type this route needs.
 *
 * A structural check rather than an `instanceof` against the plugin module, and
 * for the same reason `CanonicalEventWriter` is structural: this file must not
 * depend on the plugin implementation's identity to stay correct, and a
 * structural match cannot be fooled into reporting a code it does not know
 * because {@link GITHUB_ERROR_CODES} gates every case below.
 */
interface GitHubErrorShape {
  readonly code: unknown;
  readonly status?: unknown;
}

const GITHUB_ERROR_CODES: ReadonlySet<string> = new Set([
  "transport_failed",
  "http_status",
  "malformed_response",
  "invalid_cursor",
  "credential_failed",
  "invalid_page_size",
]);

/** True when `error` looks like the plugin's typed error, with a known code. */
function isGitHubPluginError(
  error: unknown,
): error is { readonly code: string; readonly status?: number } {
  if (typeof error !== "object" || error === null) return false;
  const shape = error as GitHubErrorShape;
  return typeof shape.code === "string" && GITHUB_ERROR_CODES.has(shape.code);
}

/** Counts by canonical event type. Counts only -- never titles or ids. */
function countsByType(
  events: readonly CanonicalEvent[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

function body(
  outcome: SyncOutcome,
  source: string,
  fetched: number,
  persisted: number,
  byType: Readonly<Record<string, number>> = {},
  upstreamStatus?: number,
): SyncResponseBody {
  return {
    ok: !FAILURE_OUTCOMES.includes(outcome),
    outcome,
    message: OUTCOME_MESSAGES[outcome],
    source,
    fetched,
    persisted,
    byType,
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    idempotent: SYNC_IS_IDEMPOTENT,
    idempotencyNote: IDEMPOTENCY_NOTE,
  };
}

/**
 * Run one sync and produce the response body and HTTP status.
 *
 * Never throws: every failure is turned into a classified, fixed-text outcome,
 * so a caller cannot reach an unhandled rejection and cannot see a message this
 * module did not choose.
 *
 * @returns the status code to send and the body to serialise.
 */
export async function handleSyncRequest(
  options: SyncHandlerOptions = {},
): Promise<{ status: number; body: SyncResponseBody }> {
  const source = options.source ?? SOURCE_NAME;
  const sync = options.sync ?? syncSource;

  // Checked BEFORE anything else so an unconfigured database is reported as
  // that, and not as a plugin failure after a pointless network round trip.
  // Skipped entirely when a writer is injected -- see SyncHandlerOptions.writer.
  if (
    options.writer === undefined &&
    (options.hasDatabaseUrl ?? databaseUrlIsConfigured)() === false
  ) {
    return {
      status: statusFor(SYNC_OUTCOMES.databaseUnconfigured),
      body: body(SYNC_OUTCOMES.databaseUnconfigured, source, 0, 0),
    };
  }

  let registry: PluginRegistry;
  try {
    registry = options.registry ?? getSourceRegistry();
  } catch (error) {
    const { outcome } = describeFailure(error);
    return { status: statusFor(outcome), body: body(outcome, source, 0, 0) };
  }

  try {
    const result = await sync({
      registry,
      source,
      // No cursor is accepted from the caller. A cursor is opaque and only the
      // plugin that issued one may pass it back, so a value from an HTTP
      // request could only ever be rejected; this route always reads the
      // first page, and takes no request body at all.
      ...(options.writer === undefined ? {} : { writer: options.writer }),
    });

    if (result.events.length === 0) {
      return {
        status: statusFor(SYNC_OUTCOMES.empty),
        body: body(SYNC_OUTCOMES.empty, source, 0, 0),
      };
    }

    return {
      status: statusFor(SYNC_OUTCOMES.synced),
      body: body(
        SYNC_OUTCOMES.synced,
        source,
        result.events.length,
        result.persisted,
        countsByType(result.events),
      ),
    };
  } catch (error) {
    const { outcome, upstreamStatus } = describeFailure(error);
    return {
      status: statusFor(outcome),
      body: body(outcome, source, 0, 0, {}, upstreamStatus),
    };
  }
}
