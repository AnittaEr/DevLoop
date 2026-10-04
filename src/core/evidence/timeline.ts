/**
 * Provider-neutral evidence timeline.
 *
 * Turns already-persisted `CanonicalEvent`s into a time-ordered, period-grouped,
 * per-source-counted summary: the aggregation layer a performance-review
 * document is rendered from (project charter principle 2, "Composed narrative",
 * and the v1 in-scope item "Period summary generator").
 *
 * PURE BY CONSTRUCTION. Everything here is synchronous and side-effect free:
 *  - no I/O, no database, no network, no plugin import;
 *  - no `Date.now()`, no `Math.random()`, no `crypto`, no ambient clock of any
 *    kind -- every instant is either parsed out of the caller's own input or
 *    supplied by the caller;
 *  - the input array is never mutated (every array that leaves this module is a
 *    freshly built copy).
 *
 * PROVIDER NEUTRALITY (60-agent-briefs.md hard rule 1). `source` is treated as
 * an opaque string and is only ever used as an object key in a tally. There is
 * deliberately no `SourceName` union, no vendor enum and no source-specific
 * constant: a name for any one provider would have to live in `src/plugins/**`,
 * and this module must stay importable by the core app without dragging a
 * plugin in. `bySource` is a `Record<string, number>` precisely so that a
 * second, a third or a renamed source needs no change here.
 *
 * `CanonicalEventType` values are never re-declared: they are read from the
 * existing {@link CANONICAL_EVENT_TYPES} constant, because a second list is how
 * two lists drift apart silently.
 */

import { z } from "zod";

import {
  CANONICAL_EVENT_TYPES,
  isCanonicalEventType,
} from "../events/canonical-event";
import type {
  CanonicalEvent,
  CanonicalEventType,
} from "../events/canonical-event";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Typed error codes, following the one convention core already has:
 * `src/core/plugins/registry.ts` (`RegistryResult` / `RegistryError` /
 * `RegistryErrorCode`). Core has one error style and this module does not
 * introduce a second one: a rejected call returns `{ ok: false, error }` with a
 * stable `code`, never a thrown-and-caught string.
 */
export const TIMELINE_ERROR_CODES = [
  /** The caller asked for no periods at all. */
  "no_periods",
  /** A period was not an object with a non-empty name and string bounds. */
  "malformed_period",
  /** A period bound was not an ISO-8601 date-time, or was unparseable. */
  "unparseable_period_bound",
  /** `from` was not strictly before `to` (inverted or zero-width range). */
  "inverted_period_range",
  /** Two periods share a name, so the output would be ambiguous. */
  "duplicate_period_name",
] as const;

export type TimelineErrorCode = (typeof TIMELINE_ERROR_CODES)[number];

/** Machine-readable, non-secret description of a rejected call. */
export interface TimelineError {
  readonly code: TimelineErrorCode;
  /**
   * The offending period's name when the failure is attributable to one
   * period; `null` when the whole period list is at fault.
   */
  readonly periodName: string | null;
  /** Human-readable explanation. Carries no event data and no caller secrets. */
  readonly message: string;
}

/** Result of a fallible call. Mirrors `RegistryResult<T>`. */
export type TimelineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TimelineError };

/* -------------------------------------------------------------------------- */
/* ISO-8601 instants                                                          */
/* -------------------------------------------------------------------------- */

/**
 * An ISO-8601 date-TIME with an explicit offset (`Z` or `±HH:MM`), optionally
 * with fractional seconds.
 *
 * The offset is REQUIRED rather than optional on purpose: a bare local time
 * (`2026-01-15T09:00:00`) has no single meaning, and a period boundary whose
 * meaning depends on the machine running the code cannot be compared
 * consistently against an event timestamp.
 *
 * The capture groups exist so the fields can be range-checked below.
 */
const ISO_8601_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Days in each month, 1-indexed; February is patched for leap years. */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * True when `value` is an ISO-8601 date-time that denotes a real instant.
 *
 * Three independent rejections, because each covers a real hazard here:
 *
 *  1. SHAPE (`ISO_8601_DATE_TIME`): rejects prose like `"last tuesday"` and
 *     `"15/01/2026"`, and rejects a bare local time, which has no single
 *     meaning and would make a period boundary depend on the host's zone.
 *  2. FIELD RANGES: `Date.parse` ACCEPTS an overflowing day and silently rolls
 *     it over -- measured: `Date.parse("2026-02-30T00:00:00Z")` is
 *     `1772409600000`, i.e. 2 March 2026, not `NaN`. On a timeline that is not
 *     a rounding detail: an event stamped `2026-02-30` would be filed in March
 *     and counted against the wrong period while looking perfectly valid. So
 *     the day is checked against that month's real length, leap years included.
 *  3. PARSEABILITY: the final belt-and-braces check for anything the host
 *     engine declines.
 *
 * Second value 60 (a leap second) is rejected rather than accepted-and-
 * normalised: `Date.parse` has no leap-second support, so accepting it here
 * would mean this function and the comparator below disagreed about the same
 * string.
 */
export function isIso8601DateTime(value: string): boolean {
  const match = ISO_8601_DATE_TIME.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) return false;
  const monthLength =
    month === 2 && isLeapYear(year) ? 29 : (MONTH_LENGTHS[month - 1] as number);
  if (day < 1 || day > monthLength) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  if (match[7] !== undefined) {
    const offsetHours = Number(match[7]);
    const offsetMinutes = Number(match[8]);
    if (offsetHours > 23 || offsetMinutes > 59) return false;
  }

  return Number.isFinite(Date.parse(value));
}

/* -------------------------------------------------------------------------- */
/* Event validation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Why an event was rejected. Stable labels, so a caller can report a malformed
 * ingestion run without inspecting the values themselves.
 */
export const EVENT_REJECTION_REASONS = [
  /** The value was not an object, so no field could be read. */
  "not_an_object",
  /** `id` was missing, not a string, or blank after trimming. */
  "missing_id",
  /** `source` was missing or not a string, so `bySource` could not key it. */
  "missing_source",
  /** `type` was not a member of `CANONICAL_EVENT_TYPES`. */
  "invalid_type",
  /** `occurredAt` was not an ISO-8601 date-time, or was unparseable. */
  "invalid_occurred_at",
] as const;

export type EventRejectionReason = (typeof EVENT_REJECTION_REASONS)[number];

export type TimelineEventValidation =
  | { readonly ok: true; readonly event: CanonicalEvent }
  | { readonly ok: false; readonly reason: EventRejectionReason };

/**
 * Validate one untrusted value against the `CanonicalEvent` contract.
 *
 * Only the four fields this module actually reads are enforced: `id`, `source`,
 * `type` and `occurredAt`. The remaining fields (`externalId`, `title`,
 * `metadata`, the optional `url`/`author`) are carried through untouched and are
 * not this module's business -- core never interprets `metadata` anyway.
 *
 * `type` is checked with {@link isCanonicalEventType}, i.e. against
 * `CANONICAL_EVENT_TYPES`, so the check cannot drift from the union.
 */
export function validateTimelineEvent(value: unknown): TimelineEventValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "not_an_object" };
  }
  const candidate = value as Partial<Record<keyof CanonicalEvent, unknown>>;

  if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
    return { ok: false, reason: "missing_id" };
  }
  if (typeof candidate.source !== "string" || candidate.source.trim() === "") {
    return { ok: false, reason: "missing_source" };
  }
  if (
    typeof candidate.type !== "string" ||
    !isCanonicalEventType(candidate.type)
  ) {
    return { ok: false, reason: "invalid_type" };
  }
  if (
    typeof candidate.occurredAt !== "string" ||
    !isIso8601DateTime(candidate.occurredAt)
  ) {
    return { ok: false, reason: "invalid_occurred_at" };
  }

  return { ok: true, event: value as CanonicalEvent };
}

/* -------------------------------------------------------------------------- */
/* Periods                                                                    */
/* -------------------------------------------------------------------------- */

/** A caller-supplied period. `name` is the caller's own label, not a preset. */
export interface TimelinePeriod {
  readonly name: string;
  /** Inclusive lower bound, ISO-8601. */
  readonly from: string;
  /** Exclusive upper bound, ISO-8601. */
  readonly to: string;
}

/**
 * Argument validation for the period list.
 *
 * `zod` carries the structural shape (a list of named, string-bounded periods);
 * the semantics that matter for correctness -- each bound really is an
 * ISO-8601 instant, and `from` is strictly before `to` -- are checked by
 * {@link isIso8601DateTime} and {@link validatePeriods} below, so that the
 * resulting {@link TimelineErrorCode} is specific rather than a generic parse
 * failure.
 */
const periodInputSchema = z.object({
  name: z.string().min(1),
  from: z.string(),
  to: z.string(),
});

/** Half-open range check: `from <= instant < to`. */
function coversInstant(instant: number, from: number, to: number): boolean {
  // The upper bound is EXCLUSIVE. Adjacent periods therefore never both claim an
  // event sitting exactly on their shared boundary: it belongs to the later one.
  return instant >= from && instant < to;
}

/**
 * Validate the caller's period list, in argument order.
 *
 * Rejects, with a distinct {@link TimelineErrorCode} for each: an empty list, a
 * blank name, a bound that is not an ISO-8601 date-time, an inverted or
 * zero-width range (`from >= to`), and two periods sharing a name.
 */
function validatePeriods(
  periods: readonly TimelinePeriod[],
): TimelineResult<readonly TimelinePeriod[]> {
  if (periods.length === 0) {
    return {
      ok: false,
      error: {
        code: "no_periods",
        periodName: null,
        message:
          "At least one period is required; an empty period list was given.",
      },
    };
  }

  const parsed: TimelinePeriod[] = [];
  const seenNames = new Set<string>();

  for (const period of periods) {
    const shape = periodInputSchema.safeParse(period);
    if (!shape.success) {
      const name =
        typeof period?.name === "string" && period.name.trim() !== ""
          ? period.name
          : null;
      return {
        ok: false,
        error: {
          code: "malformed_period",
          periodName: name,
          message:
            "A period must be an object with a non-empty name and string from/to bounds.",
        },
      };
    }

    const { name, from, to } = shape.data;

    if (seenNames.has(name)) {
      return {
        ok: false,
        error: {
          code: "duplicate_period_name",
          periodName: name,
          message: `Two periods are named "${name}"; period names must be unique.`,
        },
      };
    }

    if (!isIso8601DateTime(from) || !isIso8601DateTime(to)) {
      return {
        ok: false,
        error: {
          code: "unparseable_period_bound",
          periodName: name,
          message: `Period "${name}" needs ISO-8601 from/to bounds with an explicit offset.`,
        },
      };
    }

    // Parsed instants, not the strings: comparing two ISO-8601 strings
    // lexicographically is wrong the moment the offsets differ.
    if (Date.parse(from) >= Date.parse(to)) {
      return {
        ok: false,
        error: {
          code: "inverted_period_range",
          periodName: name,
          message: `Period "${name}" is inverted: from (${from}) must be strictly before to (${to}).`,
        },
      };
    }

    seenNames.add(name);
    parsed.push({ name, from, to });
  }

  return { ok: true, value: parsed };
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Chronological, ascending, stable.
 *
 * Stability comes from the language: `Array.prototype.sort` is specified stable
 * (ES2019), so events sharing an `occurredAt` keep their input relative order.
 * The input is not mutated -- the array is copied first -- and the comparison
 * uses parsed instants, so two spellings of the same instant (e.g. `Z` and
 * `+00:00`) compare equal rather than lexicographically.
 */
export function sortChronologically(
  events: readonly CanonicalEvent[],
): CanonicalEvent[] {
  return [...events].sort(
    (left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
  );
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A tally over `CanonicalEventType`. Only types that actually occurred are
 * present: a count of zero is noise in a period summary, and omitting it means
 * "absent" means one thing only.
 */
export type EventTypeCounts = Partial<Record<CanonicalEventType, number>>;

/** A tally keyed by the opaque `source` discriminator. */
export type EventSourceCounts = Readonly<Record<string, number>>;

/** How many rejected events fell into each reason. */
export type EventRejectionCounts = Partial<
  Record<EventRejectionReason, number>
>;

/** One period's summary. Present only when the period actually has events. */
export interface PeriodSummary {
  /** The caller's label for this period, verbatim. */
  readonly name: string;
  /** Inclusive lower bound actually applied, verbatim from the caller. */
  readonly from: string;
  /** Exclusive upper bound actually applied, verbatim from the caller. */
  readonly to: string;
  /** Matching events in chronological order (stable on ties). */
  readonly events: readonly CanonicalEvent[];
  /** `events.length`, for consumers that do not want to measure it. */
  readonly total: number;
  /** Count by event role. Keys are drawn from `CANONICAL_EVENT_TYPES`. */
  readonly byType: EventTypeCounts;
  /** Count by opaque source discriminator. */
  readonly bySource: EventSourceCounts;
}

/** The whole aggregation result. */
export interface EvidenceTimeline {
  /**
   * Periods that contain at least one event, in the caller's period order.
   * A period with no events is ABSENT rather than present with zero counts.
   */
  readonly periods: readonly PeriodSummary[];
  /** Events that landed in at least one period. */
  readonly includedEvents: number;
  /** Valid events whose `occurredAt` fell outside every requested period. */
  readonly excludedEvents: number;
  /**
   * Events rejected by {@link validateTimelineEvent}. A malformed provider row
   * is skipped, never thrown: it must not take down a review summary. The
   * breakdown says how many and why.
   */
  readonly skippedEvents: number;
  /** Why the skipped events were skipped. */
  readonly skippedByReason: EventRejectionCounts;
}

/**
 * Order a tally's keys by {@link CANONICAL_EVENT_TYPES}, so two runs over the
 * same events produce the same key order regardless of discovery order.
 */
function orderTypeKeys(counts: EventTypeCounts): EventTypeCounts {
  const ordered: EventTypeCounts = {};
  for (const type of CANONICAL_EVENT_TYPES) {
    const count = counts[type];
    if (count !== undefined) ordered[type] = count;
  }
  return ordered;
}

/**
 * Build the evidence timeline for a set of already-persisted events.
 *
 * BEHAVIOUR ON AN INVALID EVENT: SKIP AND REPORT, never throw. A single
 * malformed row in an ingested period must not cost the reviewer the whole
 * summary; the count and the reason breakdown are surfaced on the result as
 * `skippedEvents` / `skippedByReason` so the omission is visible rather than
 * silent.
 *
 * BEHAVIOUR ON A BAD PERIOD LIST: REJECT WITH A TYPED ERROR. Unlike an event, a
 * bad period is a caller bug, and silently returning an empty timeline for it
 * would be indistinguishable from "no events in range". One
 * {@link TimelineErrorCode} per defect keeps the failure diagnosable.
 *
 * An event that matches two overlapping periods appears in both. Adjacent
 * periods that merely share a boundary do NOT double-count: the upper bound is
 * exclusive.
 */
export function buildEvidenceTimeline(
  events: readonly unknown[],
  periods: readonly TimelinePeriod[],
): TimelineResult<EvidenceTimeline> {
  const validatedPeriods = validatePeriods(periods);
  if (!validatedPeriods.ok) return validatedPeriods;

  const validated = validatedPeriods.value;
  const bounds = validated.map((period) => ({
    period,
    from: Date.parse(period.from),
    to: Date.parse(period.to),
  }));

  const accepted: CanonicalEvent[] = [];
  const skippedByReason: EventRejectionCounts = {};
  let skippedEvents = 0;

  for (const candidate of events) {
    const result = validateTimelineEvent(candidate);
    if (result.ok) {
      accepted.push(result.event);
      continue;
    }
    skippedEvents += 1;
    const reason = result.reason;
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
  }

  const chronological = sortChronologically(accepted);

  // Bucket in chronological order so every period's `events` is already sorted
  // and equal-timestamp events keep their input relative order across buckets.
  const buckets: CanonicalEvent[][] = bounds.map(() => []);
  for (const event of chronological) {
    const instant = Date.parse(event.occurredAt);
    bounds.forEach((bound, index) => {
      if (coversInstant(instant, bound.from, bound.to)) {
        (buckets[index] as CanonicalEvent[]).push(event);
      }
    });
  }

  const summaries: PeriodSummary[] = [];
  let includedEvents = 0;

  bounds.forEach((bound, index) => {
    const matched = buckets[index] as CanonicalEvent[];
    // An empty period is ABSENT, not a zero row: a summary that renders a blank
    // quarter is worse than one that omits it.
    if (matched.length === 0) return;

    const byType: EventTypeCounts = {};
    const bySource: Record<string, number> = {};
    for (const event of matched) {
      byType[event.type] = (byType[event.type] ?? 0) + 1;
      bySource[event.source] = (bySource[event.source] ?? 0) + 1;
    }
    includedEvents += matched.length;

    summaries.push({
      name: bound.period.name,
      from: bound.period.from,
      to: bound.period.to,
      events: matched,
      total: matched.length,
      byType: orderTypeKeys(byType),
      bySource,
    });
  });

  return {
    ok: true,
    value: {
      periods: summaries,
      includedEvents,
      excludedEvents: accepted.length - includedEvents,
      skippedEvents,
      skippedByReason,
    },
  };
}
