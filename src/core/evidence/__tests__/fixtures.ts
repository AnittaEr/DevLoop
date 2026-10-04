/**
 * Fixed test fixtures for the evidence timeline.
 *
 * EVERY timestamp below is a LITERAL string. There is no `new Date()`, no
 * `Date.now()` and no relative date anywhere in this file: a date-relative
 * fixture passes on the day it was written and fails on a different day, which
 * is the classic flaky-timeline bug. If a test needs a new instant, it adds a
 * literal here and reads the number of literals out loud.
 *
 * The `source` values are deliberately invented, opaque, provider-neutral
 * labels. They are not stand-ins for any real product: a fixture that named a
 * real one would drag that vendor's vocabulary into `src/core/**` and trip the
 * plugin-boundary guard for no benefit (hard rule 1).
 */

import type {
  CanonicalEvent,
  CanonicalEventType,
} from "../../events/canonical-event";

/** Opaque fixture sources. Never interpreted by the module under test. */
export const FIXTURE_SOURCES = {
  primary: "fixture-primary",
  secondary: "fixture-secondary",
} as const;

/** Literal instants, named so a test reads as a range it can check by eye. */
export const AT = {
  /** One nanosecond before January, to prove the half-open upper bound. */
  beforeJanuary: "2025-12-31T23:59:59.999Z",
  januaryFirst: "2026-01-01T00:00:00.000Z",
  januaryMid: "2026-01-15T09:00:00.000Z",
  januaryLate: "2026-01-28T17:30:00.000Z",
  /** Exactly the exclusive upper bound of the January period. */
  februaryFirst: "2026-02-01T00:00:00.000Z",
  februaryMid: "2026-02-14T12:00:00.000Z",
  marchFirst: "2026-03-01T00:00:00.000Z",
  marchLate: "2026-03-20T08:15:00.000Z",
} as const;

/** The January period: `[2026-01-01T00:00:00.000Z, 2026-02-01T00:00:00.000Z)`. */
export const JANUARY = {
  name: "january-2026",
  from: AT.januaryFirst,
  to: AT.februaryFirst,
} as const;

/** The February period, adjacent to {@link JANUARY} and sharing its boundary. */
export const FEBRUARY = {
  name: "february-2026",
  from: AT.februaryFirst,
  to: AT.marchFirst,
} as const;

/**
 * A March period that is requested but will be left EMPTY by most fixtures, so
 * the "empty period is absent" rule has a period to be absent about.
 */
export const MARCH = {
  name: "march-2026",
  from: AT.marchFirst,
  to: "2026-04-01T00:00:00.000Z",
} as const;

export interface EventOverrides {
  readonly id?: string;
  readonly source?: string;
  readonly type?: CanonicalEventType;
  readonly occurredAt?: string;
  readonly title?: string;
}

/**
 * Build one valid fixture event.
 *
 * `type` and `occurredAt` default to literals, so the common case is a call
 * that cannot accidentally become date-relative.
 */
export function makeEvent(
  occurredAt: string,
  type: CanonicalEventType,
  overrides: EventOverrides = {},
): CanonicalEvent {
  return {
    id: overrides.id ?? `evt-${type}-${occurredAt}`,
    source: overrides.source ?? FIXTURE_SOURCES.primary,
    externalId: `ext-${type}`,
    type,
    title: overrides.title ?? `Fixture ${type}`,
    occurredAt,
    metadata: {},
  };
}

/** A January event. */
export const januaryIssue = makeEvent(AT.januaryMid, "issue");
export const januaryReview = makeEvent(AT.januaryLate, "change_review");
export const januaryRelease = makeEvent(AT.januaryMid, "release");

/** A February event, landing exactly on the January/February boundary. */
export const februaryComment = makeEvent(AT.februaryFirst, "issue_comment");

/** A March event. */
export const marchProposal = makeEvent(AT.marchLate, "change_proposal");
