/**
 * Row <-> `CanonicalEvent` mapping for `canonical_events`.
 *
 * This is the *type <-> storage* boundary, not the *provider -> type* boundary:
 * turning a source's payload into a `CanonicalEvent` belongs to the plugin layer
 * (T106) and no provider vocabulary may appear here or in the columns this maps.
 *
 * `occurredAt` is the only lossy-looking field. It is an ISO-8601 string on the
 * type but a `timestamptz` in Postgres, so it is parsed on write and
 * re-serialised on read. `toISOString()` always renders UTC with millisecond
 * precision and a trailing `Z`, so a round trip is exact for any instant the type
 * can express, but an input with a different textual form (e.g. `+02:00` offset,
 * or omitted milliseconds) is normalised rather than preserved byte-for-byte. The
 * round-trip test pins that normalisation explicitly so it cannot drift.
 *
 * WHAT THE WRITER REJECTS (B27, findings 4 and 5). Two properties of an
 * ISO-8601 string are unrepresentable in this schema, and both were previously
 * accepted silently:
 *
 *  1. An OFFSET-LESS value (`2026-10-04T12:31:07`) is not an instant at all —
 *     ISO-8601 leaves it to be read in the *local* zone of whatever parses it.
 *     `new Date()` resolves it in the PROCESS timezone, so the same event would
 *     persist a different `occurred_at` on two hosts with different TZ. That is a
 *     silently wrong row, not a rounding difference, and it is unfixable after
 *     the fact because nothing in the row records which zone was assumed. The
 *     writer therefore requires an explicit `Z` or `±HH:MM`.
 *  2. SUB-MILLISECOND precision (`.0001`) cannot survive: `Date` holds whole
 *     milliseconds, so `toISOString()` drops the extra digits. Accepting it
 *     means silently writing a value the caller did not supply. It is rejected
 *     rather than rounded.
 *
 * Rejecting is deliberately preferred over normalising or preserving. `metadata`
 * exists so a plugin can carry anything shape-specific without widening the core
 * type, but `occurredAt` is a core scalar with no such escape hatch: a
 * half-supported timestamp here would be a data-loss bug reported much later.
 * Both rejections are cheap and loud at the boundary where they belong.
 *
 * WHAT THE WRITER REFUSES TO EMIT (T18). `metadata` additionally carries a small
 * reserved namespace of its own — see {@link RESERVED_METADATA_KEYS} — which the
 * writer refuses at the top level, for the same reason: a value it cannot store
 * faithfully is rejected loudly at the boundary rather than silently mangled.
 * The two guards are independent and compose; the `metadata` check runs first, so
 * a reserved key is rejected before `occurredAt` is even parsed.
 */

import type {
  CanonicalEvent,
  JsonObject,
} from "../src/core/events/canonical-event";
import { isIso8601DateTime } from "../src/core/evidence/timeline";
import type { CanonicalEventRow } from "./schema";

/**
 * An ISO-8601 date-time that carries an explicit UTC offset.
 *
 * Anchored to `T` + a time, then either `Z` or a signed `±HH:MM`. The colon in
 * the offset is REQUIRED: the basic-format `±HHMM` spelling that ISO-8601 also
 * permits is deliberately not accepted. Fractional seconds are optional here
 * and checked for representability separately, because `Date` truncates below
 * milliseconds.
 *
 * This is a deliberately narrow shape, not a full ISO-8601 parser: the core
 * domain types `occurredAt` as "ISO-8601 timestamp", and the storage layer's job
 * is to reject what it cannot faithfully persist, not to accept every form the
 * standard permits. A writer that guessed would be guessing.
 */
const OFFSET_BEARING_ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The part of an ISO-8601 value after the seconds, i.e. the fraction. */
const FRACTION = /\.(\d+)/;

/** Postgres `timestamptz` resolves at microsecond precision; `Date` at millisecond. */
const REPRESENTABLE_FRACTION_DIGITS = 3;

/**
 * Top-level `metadata` key the writer refuses to emit, reserved by the
 * remediation path in `db/migrations/0002_loud_johnny_blaze.sql`: that migration
 * wraps the original value of a pre-migration row whose `metadata` was not a
 * JSON object under exactly this key, so a row carrying it at the top level is
 * by definition a *remediated* row and not plugin-authored data.
 *
 * SCOPE IS THE TOP LEVEL ONLY, DELIBERATELY. A nested occurrence
 * (`metadata.nested._devloop_legacy_non_object`) cannot be confused with the
 * remediation shape, because the remediation rewrites the WHOLE column to
 * `{"_devloop_legacy_non_object": <original>}` — a nested key is always inside
 * the wrapped value. Sibling keys that merely *start with* the reserved name
 * (`_devloop_legacy_non_object_nested`) are equally unrelated, and
 * `metadata` exists precisely so a plugin can carry anything shape-specific
 * without widening the core type; reserving a prefix or recursing into the
 * value would destroy legitimate plugin data to prevent a collision that cannot
 * occur. The guard therefore tests own top-level keys only.
 *
 * Rejected rather than stripped or renamed: this is a reserved namespace, and a
 * silent strip would discard a plugin's real key just as surely as storing it
 * would, while a rename would leave the caller believing its data was written.
 * A loud throw at the boundary is the only outcome that is never a lie.
 */
export const RESERVED_METADATA_KEYS: readonly string[] = [
  "_devloop_legacy_non_object",
];

/**
 * Converts a `CanonicalEvent` into its insertable row shape.
 *
 * Returns the SELECT row shape rather than `NewCanonicalEventRow`. It is a
 * strict superset of what an insert accepts (every optional-on-insert column is
 * materialised, `url`/`author` as explicit `null`), so it is still assignable
 * wherever an insert value is expected — while being the shape this module's
 * reader consumes, which keeps the two functions symmetrical.
 *
 * @throws TypeError if `occurredAt` is not a parseable ISO-8601 value, omits its
 * UTC offset, or carries sub-millisecond precision — see the module comment for
 * why each of those is a rejection rather than a silent normalisation.
 * @throws TypeError if `metadata` carries a reserved top-level key — see
 * {@link RESERVED_METADATA_KEYS} for why this is a rejection rather than a
 * normalisation, and for why the scope is the top level only.
 */
export function toCanonicalEventRow(event: CanonicalEvent): CanonicalEventRow {
  assertNoReservedMetadataKeys(event.metadata);
  const occurredAt = parseOccurredAt(event.occurredAt);

  return {
    id: event.id,
    source: event.source,
    externalId: event.externalId,
    type: event.type,
    title: event.title,
    // Parsed to a Date; Drizzle/bind hands a Date to Postgres for timestamptz.
    occurredAt,
    url: event.url ?? null,
    author: event.author ?? null,
    // Structured-cloned so a caller mutating the event afterwards cannot change
    // the row (and so the value is provably JSON-safe before it reaches jsonb).
    metadata: structuredClone(event.metadata) as JsonObject,
  };
}

/**
 * Throws if `metadata` carries any reserved key at its own top level.
 *
 * Own top-level keys only, matching the scope documented on
 * {@link RESERVED_METADATA_KEYS}. `Object.keys` rather than `in` because it
 * yields own enumerable properties only: an `in` check would also see a
 * prototype-chain hit (e.g. an `Object.prototype` poisoning attack that adds
 * the reserved name) and make an unrelated event look reserved, and would see
 * a non-enumerable own property that JSON would never carry to the column.
 */
function assertNoReservedMetadataKeys(metadata: JsonObject): void {
  for (const key of Object.keys(metadata)) {
    if (!RESERVED_METADATA_KEYS.includes(key)) {
      continue;
    }
    throw new TypeError(
      `CanonicalEvent.metadata carries the reserved top-level key ` +
        `${JSON.stringify(key)}, which the writer refuses to emit. ` +
        `db/migrations/0002_loud_johnny_blaze.sql uses that key to mark a ` +
        `pre-migration row whose metadata was not a JSON object, so a row ` +
        `carrying it cannot be told apart from a remediated one — and ` +
        `"reverse the remediation" would then corrupt the plugin's own data. ` +
        `Only the TOP-LEVEL key is reserved: a nested occurrence, or a ` +
        `sibling key that merely starts with the same name, is accepted ` +
        `unchanged. Rename the key to proceed.`,
    );
  }
}

/**
 * Parses `occurredAt` into the `Date` that will be handed to Postgres.
 *
 * Split out from the row literal so every rejection carries a message naming
 * the offending value: a bare `Invalid Date` reaching a `timestamptz` bind is the
 * kind of failure that surfaces as an opaque driver error far from its cause.
 */
function parseOccurredAt(occurredAt: string): Date {
  if (!OFFSET_BEARING_ISO.test(occurredAt)) {
    throw new TypeError(
      `CanonicalEvent.occurredAt must be an ISO-8601 timestamp with an explicit ` +
        `UTC offset ("...Z" or "...±HH:MM"), so the instant does not depend on the ` +
        `host's timezone; received: ${JSON.stringify(occurredAt)}`,
    );
  }

  const digits = FRACTION.exec(occurredAt)?.[1] ?? "";
  if (
    digits.length > REPRESENTABLE_FRACTION_DIGITS &&
    !/^0+$/.test(digits.slice(REPRESENTABLE_FRACTION_DIGITS))
  ) {
    throw new TypeError(
      `CanonicalEvent.occurredAt carries more precision than a Date can hold ` +
        `(${REPRESENTABLE_FRACTION_DIGITS} fractional digits); it would be ` +
        `silently truncated on write: ${JSON.stringify(occurredAt)}`,
    );
  }

  const parsed = new Date(occurredAt);

  // CALENDAR VALIDITY, and it is checked SEPARATELY from `new Date()` because
  // `new Date()` does not reject an impossible date — it ROLLS IT OVER.
  // MEASURED: `new Date("2026-02-30T12:31:07Z")` is 2 March 2026, not NaN, so
  // the NaN guard below can never fire for a rolled calendar date. Before this
  // check, that value passed the shape regex, passed the fraction check, and was
  // persisted as `occurred_at = 2026-03-02T12:31:07.000Z` — precisely the
  // "silently wrong row" this module's own header says it exists to prevent, and
  // it would be filed against the wrong period while looking perfectly valid.
  //
  // `isIso8601DateTime` is the DOMAIN's validator for this exact question: it
  // range-checks the day against that month's real length with leap years
  // handled, rejects a leap second, and rejects an out-of-range offset. It is
  // used rather than re-derived because a second calendar rule here is how two
  // rules drift apart silently — the two layers disagreeing about which strings
  // are valid instants is the defect that made this necessary.
  //
  // On the import: `db/**` is the persistence layer and the canonical timestamp
  // contract lives in `src/core/**`, so reaching up to the domain validator is
  // the correct direction and trips no boundary guard (the `db/**` guard
  // forbids `src/plugins/**`, `node_modules/**` and provider SDKs — not core).
  // The rule arguably belongs beside `CanonicalEvent` itself rather than in the
  // evidence-timeline module it currently lives in; moving it is a `src/core/**`
  // change, outside this branch's scope, and is raised as follow-up instead.
  if (!isIso8601DateTime(occurredAt)) {
    throw new TypeError(
      `CanonicalEvent.occurredAt is not a real calendar instant ` +
        `(an impossible date such as 2026-02-30 would be silently rolled over ` +
        `to a different day): ${JSON.stringify(occurredAt)}`,
    );
  }

  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(
      `CanonicalEvent.occurredAt is not a valid date: ${JSON.stringify(occurredAt)}`,
    );
  }
  return parsed;
}

/**
 * Converts a selected row back into a `CanonicalEvent`.
 *
 * Typed against the SELECT row shape, not the INSERT shape. The two differ in
 * exactly the fields that matter here: `metadata` is `optional` on insert but
 * `NOT NULL` on select, so typing the parameter as the insert row made the
 * `?? {}` fallback below look necessary while being unreachable on the real read
 * path — and typing it as the insert row also allowed `occurredAt` to be typed
 * loosely. It is a selected row that this converts, so that is what it takes.
 */
export function fromCanonicalEventRow(row: CanonicalEventRow): CanonicalEvent {
  // Built with spreads rather than post-assignment: CanonicalEvent's fields are
  // readonly, so the optional keys must be included at construction time (and
  // omitted entirely when absent, so the result deep-equals an input that
  // omitted them).
  return {
    id: row.id,
    source: row.source,
    externalId: row.externalId,
    // The column is typed as CanonicalEventType and CHECKed by the database, so
    // this is no longer a cast that has to be believed.
    type: row.type,
    title: row.title,
    occurredAt: row.occurredAt.toISOString(),
    // NOT NULL with a `{}` default: there is no absent case to fall back from.
    metadata: row.metadata,
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.author !== null ? { author: row.author } : {}),
  };
}
