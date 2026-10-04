/**
 * Behaviour tests for the provider-neutral evidence timeline.
 *
 * These assert observable behaviour of the aggregation -- ordering, half-open
 * boundary membership, absent empty periods, the counts, and the skip/report
 * contract -- rather than implementation detail. The card's stated failure mode
 * is "a summariser whose tests pass whether or not the grouping works", which
 * is why the boundary and counting cases below are written against explicit
 * literals and paired controls.
 */

import { describe, expect, it } from "vitest";

import { CANONICAL_EVENT_TYPES } from "../../events/canonical-event";
import type { CanonicalEvent } from "../../events/canonical-event";
import {
  TIMELINE_ERROR_CODES,
  buildEvidenceTimeline,
  isIso8601DateTime,
  sortChronologically,
  validateTimelineEvent,
} from "../timeline";
import type { EvidenceTimeline, TimelinePeriod } from "../timeline";
import {
  AT,
  FEBRUARY,
  FIXTURE_SOURCES,
  JANUARY,
  MARCH,
  februaryComment,
  januaryIssue,
  januaryRelease,
  januaryReview,
  makeEvent,
  marchProposal,
} from "./fixtures";

/** Build and unwrap, failing loudly (and typed) if the call was rejected. */
function timeline(
  events: readonly unknown[],
  periods: readonly TimelinePeriod[] = [JANUARY],
): EvidenceTimeline {
  const result = buildEvidenceTimeline(events, periods);
  if (!result.ok) {
    throw new Error(`expected ok, got error ${result.error.code}`);
  }
  return result.value;
}

/** Build expecting rejection, returning the error code. */
function errorCode(
  events: readonly unknown[],
  periods: readonly TimelinePeriod[],
): string {
  const result = buildEvidenceTimeline(events, periods);
  if (result.ok) {
    throw new Error(
      `expected a rejection, got ${result.value.periods.length} periods`,
    );
  }
  return result.error.code;
}

const ids = (events: readonly CanonicalEvent[]): string[] =>
  events.map((event) => event.id);

describe("ISO-8601 recognition", () => {
  it("accepts UTC and explicit-offset date-times", () => {
    for (const value of [
      AT.januaryMid,
      AT.beforeJanuary,
      "2026-01-15T09:00:00+02:00",
      "2026-01-15T09:00:00.123456Z",
      // A real leap day in a leap year must be accepted.
      "2024-02-29T00:00:00Z",
    ]) {
      expect(isIso8601DateTime(value), value).toBe(true);
    }
  });

  it("rejects prose, non-ISO formats, bare local times and impossible dates", () => {
    for (const value of [
      "last tuesday",
      "15/01/2026",
      "2026-01-15",
      // Bare local time: no offset, so no single meaning.
      "2026-01-15T09:00:00",
      // Well-shaped but not a real instant. `Date.parse` ROLLS THESE OVER
      // rather than returning NaN (measured: "2026-02-30T00:00:00Z" parses to
      // 1772409600000, which is 2 March), so a parse-only check would file an
      // impossible timestamp in the wrong period while looking valid.
      "2026-02-30T00:00:00Z",
      "2026-04-31T00:00:00Z",
      // 2026 is not a leap year, so this day does not exist.
      "2026-02-29T00:00:00Z",
      // Right shape, out-of-range field.
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2026-01-32T00:00:00Z",
      "2026-01-15T25:00:00Z",
      "2026-01-15T09:60:00Z",
      "2026-01-15T09:00:00+99:00",
      "",
    ]) {
      expect(isIso8601DateTime(value), value).toBe(false);
    }
  });
});

describe("event validation", () => {
  it("accepts a well-formed event unchanged", () => {
    const result = validateTimelineEvent(januaryIssue);
    expect(result.ok).toBe(true);
  });

  it("rejects each contract violation with a named reason", () => {
    const cases: ReadonlyArray<[unknown, string]> = [
      [null, "not_an_object"],
      ["a string", "not_an_object"],
      [[januaryIssue], "not_an_object"],
      [{ ...januaryIssue, id: "" }, "missing_id"],
      [{ ...januaryIssue, id: "   " }, "missing_id"],
      [{ ...januaryIssue, id: undefined }, "missing_id"],
      [{ ...januaryIssue, source: "" }, "missing_source"],
      [{ ...januaryIssue, source: 7 }, "missing_source"],
      [{ ...januaryIssue, type: "unknown_event_kind" }, "invalid_type"],
      [{ ...januaryIssue, type: "" }, "invalid_type"],
      [{ ...januaryIssue, occurredAt: "yesterday" }, "invalid_occurred_at"],
      [{ ...januaryIssue, occurredAt: "2026-01-15" }, "invalid_occurred_at"],
      [{ ...januaryIssue, occurredAt: "" }, "invalid_occurred_at"],
    ];

    for (const [candidate, reason] of cases) {
      const result = validateTimelineEvent(candidate);
      expect(result.ok, JSON.stringify(candidate)).toBe(false);
      if (!result.ok)
        expect(result.reason, JSON.stringify(candidate)).toBe(reason);
    }
  });

  it("accepts every type in the canonical constant", () => {
    // The check reads CANONICAL_EVENT_TYPES rather than a local list, so this
    // is the assertion that would fail first if a second list were introduced.
    for (const type of CANONICAL_EVENT_TYPES) {
      expect(validateTimelineEvent(makeEvent(AT.januaryMid, type)).ok).toBe(
        true,
      );
    }
  });
});

describe("chronological ordering", () => {
  it("sorts a single stream ascending regardless of input order", () => {
    // Deliberately calls the exported sorter DIRECTLY. The only assertion that
    // can see the sorter's behaviour on its own is one that does not go through
    // period grouping first: grouping orders periods by the CALLER's period
    // order, so a test that only flattens periods across several of them stays
    // green when the sorter is mutated to a no-op.
    //
    // Non-vacuity control, measured: with `sortChronologically` mutated to
    // `return [...events]` this case failed and the grouping-level cases did
    // not, which is what motivated it.
    const sorted = sortChronologically([
      januaryReview,
      januaryIssue,
      januaryRelease,
      februaryComment,
    ]);
    expect(sorted.map((event) => event.occurredAt)).toEqual([
      AT.januaryMid, // januaryIssue
      AT.januaryMid, // januaryRelease
      AT.januaryLate, // januaryReview
      AT.februaryFirst,
    ]);
  });

  it("orders a single period's events ascending even when they arrive reversed", () => {
    const result = timeline([januaryReview, januaryIssue], [JANUARY]);
    expect(ids(result.periods[0]?.events ?? [])).toEqual([
      januaryIssue.id,
      januaryReview.id,
    ]);
  });

  it("orders events ascending by occurredAt across periods", () => {
    const shuffled = [
      marchProposal,
      januaryIssue,
      februaryComment,
      januaryReview,
    ];
    const result = timeline(shuffled, [JANUARY, FEBRUARY, MARCH]);

    const ordered = result.periods.flatMap((period) => ids(period.events));
    expect(ordered).toEqual([
      januaryIssue.id,
      januaryReview.id,
      februaryComment.id,
      marchProposal.id,
    ]);
  });

  it("is stable for equal timestamps, keeping input relative order", () => {
    // januaryIssue and januaryRelease share AT.januaryMid deliberately.
    const result = timeline([januaryRelease, januaryIssue], [JANUARY]);
    expect(ids(result.periods[0]?.events ?? [])).toEqual([
      januaryRelease.id,
      januaryIssue.id,
    ]);

    // ...and the same input in the other order stays in that order.
    const reversed = timeline([januaryIssue, januaryRelease], [JANUARY]);
    expect(ids(reversed.periods[0]?.events ?? [])).toEqual([
      januaryIssue.id,
      januaryRelease.id,
    ]);
  });

  it("compares instants, not timestamp spellings", () => {
    // Same instant, two spellings. A lexicographic sort would disagree with
    // itself about ordering across `Z` and `+00:00`.
    const offsetForm = makeEvent("2026-01-15T09:00:00+00:00", "mention");
    const sorted = sortChronologically([offsetForm, januaryIssue]);
    expect(Date.parse(sorted[0]!.occurredAt)).toBe(
      Date.parse(sorted[1]!.occurredAt),
    );
  });

  it("does not mutate its input array", () => {
    const input = [marchProposal, januaryIssue];
    const snapshot = [...input];
    timeline(input, [JANUARY, FEBRUARY, MARCH]);
    expect(input).toEqual(snapshot);

    const toSort = [marchProposal, januaryIssue];
    sortChronologically(toSort);
    expect(toSort).toEqual([marchProposal, januaryIssue]);
  });

  it("is deterministic: same input gives an equal result every time", () => {
    const events = [januaryReview, januaryIssue, februaryComment];
    const periods = [JANUARY, FEBRUARY];
    expect(timeline(events, periods)).toEqual(timeline(events, periods));
  });
});

describe("half-open period membership", () => {
  it("includes an event exactly on `from`", () => {
    const onFrom = makeEvent(AT.januaryFirst, "issue");
    const result = timeline([onFrom], [JANUARY]);
    expect(ids(result.periods[0]?.events ?? [])).toEqual([onFrom.id]);
  });

  it("EXCLUDES an event exactly on `to`", () => {
    // The boundary case the card is probed on. `to` is exclusive, so this
    // event belongs to the NEXT period, not this one.
    const onTo = makeEvent(AT.februaryFirst, "issue");
    const result = timeline([onTo], [JANUARY]);
    expect(result.periods).toEqual([]);
    expect(result.excludedEvents).toBe(1);
  });

  it("does not double-count an event on an adjacent periods' shared boundary", () => {
    const onBoundary = makeEvent(AT.februaryFirst, "issue");
    const result = timeline([onBoundary], [JANUARY, FEBRUARY]);

    expect(result.periods).toHaveLength(1);
    expect(result.periods[0]?.name).toBe(FEBRUARY.name);
    expect(result.periods[0]?.total).toBe(1);
    expect(result.includedEvents).toBe(1);
    expect(result.excludedEvents).toBe(0);
  });

  it("excludes an event before every requested period", () => {
    const stale = makeEvent(AT.beforeJanuary, "issue");
    const result = timeline([stale, januaryIssue], [JANUARY]);
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0]?.total).toBe(1);
    expect(result.excludedEvents).toBe(1);
  });

  it("counts an event that matches two genuinely overlapping periods in both", () => {
    // Overlap is the caller's choice and is not silently de-duplicated.
    const wide = { name: "wide", from: AT.januaryFirst, to: AT.marchLate };
    const result = timeline([januaryIssue, januaryReview], [JANUARY, wide]);
    expect(result.periods.map((period) => period.name)).toEqual([
      "january-2026",
      "wide",
    ]);
    expect(result.periods[0]?.total).toBe(2);
    expect(result.periods[1]?.total).toBe(2);
    expect(result.includedEvents).toBe(4);
  });
});

describe("empty periods", () => {
  it("omits a period with no events rather than emitting a zero row", () => {
    const result = timeline([januaryIssue], [JANUARY, MARCH]);
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0]?.name).toBe(JANUARY.name);
    expect(result.periods.map((period) => period.name)).not.toContain(
      MARCH.name,
    );
  });

  it("returns no periods at all when nothing falls in range", () => {
    const result = timeline([makeEvent(AT.beforeJanuary, "issue")], [MARCH]);
    expect(result.periods).toEqual([]);
    expect(result.includedEvents).toBe(0);
    expect(result.excludedEvents).toBe(1);
  });

  it("keeps the caller's period order among the non-empty ones", () => {
    const result = timeline([marchProposal, januaryIssue], [MARCH, JANUARY]);
    expect(result.periods.map((period) => period.name)).toEqual([
      MARCH.name,
      JANUARY.name,
    ]);
  });
});

describe("period contents and counts", () => {
  it("carries the bounds actually applied and the total", () => {
    const result = timeline([januaryIssue, januaryReview], [JANUARY]);
    const period = result.periods[0];
    expect(period?.from).toBe(JANUARY.from);
    expect(period?.to).toBe(JANUARY.to);
    expect(period?.name).toBe(JANUARY.name);
    expect(period?.total).toBe(2);
    expect(period?.events).toHaveLength(2);
  });

  it("counts by event type", () => {
    const result = timeline(
      [januaryIssue, januaryReview, januaryIssue],
      [JANUARY],
    );
    expect(result.periods[0]?.byType).toEqual({ issue: 2, change_review: 1 });
  });

  it("counts by the opaque source discriminator", () => {
    const fromSecondary = makeEvent(AT.januaryMid, "issue", {
      source: FIXTURE_SOURCES.secondary,
    });
    const result = timeline(
      [januaryIssue, januaryReview, fromSecondary],
      [JANUARY],
    );
    expect(result.periods[0]?.bySource).toEqual({
      [FIXTURE_SOURCES.primary]: 2,
      [FIXTURE_SOURCES.secondary]: 1,
    });
  });

  it("emits byType keys drawn from the canonical constant, in its order", () => {
    const events = [
      makeEvent(AT.januaryMid, "mention"),
      makeEvent(AT.januaryMid, "issue"),
      makeEvent(AT.januaryMid, "release"),
    ];
    const period = timeline(events, [JANUARY]).periods[0];
    expect(Object.keys(period?.byType ?? {})).toEqual([
      "issue",
      "release",
      "mention",
    ]);
    // No count for a type that did not occur, and no type outside the constant.
    for (const key of Object.keys(period?.byType ?? {})) {
      expect(CANONICAL_EVENT_TYPES).toContain(key);
    }
    expect(Object.keys(period?.byType ?? {})).not.toContain("issue_comment");
  });

  it("aggregates the totals across periods", () => {
    const result = timeline(
      [januaryIssue, januaryReview, februaryComment, marchProposal],
      [JANUARY, FEBRUARY, MARCH],
    );
    expect(result.includedEvents).toBe(4);
    expect(result.excludedEvents).toBe(0);
    expect(result.skippedEvents).toBe(0);
    expect(result.skippedByReason).toEqual({});
  });
});

describe("invalid events are skipped, not thrown", () => {
  it("keeps the valid events and reports the skipped count and reasons", () => {
    const result = timeline(
      [
        januaryIssue,
        { ...januaryIssue, id: "" },
        { ...januaryIssue, type: "unknown_event_kind" },
        { ...januaryIssue, occurredAt: "whenever" },
        "not an event at all",
      ],
      [JANUARY],
    );

    expect(result.periods[0]?.total).toBe(1);
    expect(ids(result.periods[0]?.events ?? [])).toEqual([januaryIssue.id]);
    expect(result.skippedEvents).toBe(4);
    expect(result.skippedByReason).toEqual({
      missing_id: 1,
      invalid_type: 1,
      invalid_occurred_at: 1,
      not_an_object: 1,
    });
  });

  it("returns zero periods when every event is invalid", () => {
    const result = timeline([{ id: "" }, null, 42], [JANUARY]);
    expect(result.periods).toEqual([]);
    expect(result.includedEvents).toBe(0);
    expect(result.excludedEvents).toBe(0);
    expect(result.skippedEvents).toBe(3);
  });

  it("does not throw on any invalid input shape", () => {
    for (const candidate of [undefined, null, 0, "", [], {}, { id: "x" }]) {
      expect(() => timeline([candidate], [JANUARY])).not.toThrow();
    }
  });
});

describe("period-list argument validation", () => {
  it("rejects an empty period list", () => {
    expect(errorCode([], [])).toBe("no_periods");
  });

  it("rejects an inverted range", () => {
    expect(
      errorCode(
        [],
        [{ name: "backwards", from: AT.marchFirst, to: AT.januaryFirst }],
      ),
    ).toBe("inverted_period_range");
  });

  it("rejects a zero-width range", () => {
    expect(
      errorCode(
        [],
        [{ name: "point", from: AT.januaryFirst, to: AT.januaryFirst }],
      ),
    ).toBe("inverted_period_range");
  });

  it("rejects an unparseable bound", () => {
    for (const bad of [
      "not-a-date",
      "2026-01-15",
      "",
      "2026-13-01T00:00:00Z",
    ]) {
      expect(
        errorCode([], [{ name: "bad", from: bad, to: AT.marchFirst }]),
        bad,
      ).toBe("unparseable_period_bound");
      expect(
        errorCode([], [{ name: "bad", from: AT.januaryFirst, to: bad }]),
        bad,
      ).toBe("unparseable_period_bound");
    }
  });

  it("rejects a malformed period object", () => {
    expect(
      errorCode([], [{ name: "", from: AT.januaryFirst, to: AT.marchFirst }]),
    ).toBe("malformed_period");
    expect(
      errorCode(
        [],
        [{ name: "bad", from: AT.januaryFirst } as unknown as TimelinePeriod],
      ),
    ).toBe("malformed_period");
  });

  it("rejects two periods sharing a name", () => {
    expect(errorCode([], [JANUARY, { ...FEBRUARY, name: JANUARY.name }])).toBe(
      "duplicate_period_name",
    );
  });

  it("names the offending period on the error", () => {
    const result = buildEvidenceTimeline(
      [],
      [
        { name: "good", from: AT.januaryFirst, to: AT.marchFirst },
        { name: "bad", from: AT.marchFirst, to: AT.januaryFirst },
      ],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("inverted_period_range");
      expect(result.error.periodName).toBe("bad");
      expect(result.error.message).toContain("bad");
    }
  });

  it("uses a code from the declared set, so a caller can exhaustively switch", () => {
    for (const periods of [
      [],
      [{ name: "bad", from: AT.marchFirst, to: AT.januaryFirst }],
      [{ name: "bad", from: "nope", to: AT.marchFirst }],
      [JANUARY, { ...FEBRUARY, name: JANUARY.name }],
    ]) {
      const result = buildEvidenceTimeline([], periods);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(TIMELINE_ERROR_CODES).toContain(result.error.code);
    }
  });
});

describe("purity", () => {
  it("returns an equal result for repeated calls with no arguments mutated", () => {
    const events = [januaryReview, januaryIssue, februaryComment];
    const periods = [JANUARY, FEBRUARY];
    const eventsSnapshot = JSON.stringify(events);
    const periodsSnapshot = JSON.stringify(periods);

    const first = timeline(events, periods);
    const second = timeline(events, periods);

    expect(first).toEqual(second);
    expect(JSON.stringify(events)).toBe(eventsSnapshot);
    expect(JSON.stringify(periods)).toBe(periodsSnapshot);
  });

  it("does not hand out a mutable view of the caller's arrays", () => {
    const events = [januaryIssue];
    const result = timeline(events, [JANUARY]);
    // The returned period events are a copy, not the caller's array.
    expect(result.periods[0]?.events).not.toBe(events);
  });

  it("holds no reference to the input event objects' array", () => {
    const events: CanonicalEvent[] = [januaryIssue, januaryReview];
    const result = timeline(events, [JANUARY]);
    events.length = 0;
    expect(result.periods[0]?.total).toBe(2);
  });
});
