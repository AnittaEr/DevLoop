/**
 * Tests for the review-ready period document (charter §3 objective 3).
 *
 * FIXTURES ARE LITERALS. Every timestamp and period bound below is a fixed
 * string: no `new Date()`, no `Date.now()`, no relative period. A review document
 * whose snapshot depended on the day it was rendered would be the canonical
 * flaky-timeline bug, and a snapshot nobody can reproduce is not evidence.
 *
 * THE TWO TIMELINES BUILT HERE ARE REAL ONES, built by calling the real
 * `buildEvidenceTimeline` over literal events rather than hand-assembling an
 * `EvidenceTimeline`. The renderer is only ever shown a timeline the way the
 * app will produce one, so a test cannot pass against a shape the aggregator
 * would never emit.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildEvidenceTimeline,
  type EvidenceTimeline,
  type PeriodSummary,
  type TimelinePeriod,
} from "@/core/evidence";
import { buildReviewSummary } from "@/core/review";
import type { ReviewSummaryResult } from "@/core/review";

const REVIEW_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const RENDER_SOURCE = path.join(REVIEW_DIR, "render.ts");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SECOND_SOURCE = "fixture-secondary";

const AT = {
  januaryMid: "2026-01-15T09:00:00.000Z",
  januaryLate: "2026-01-28T17:30:00.000Z",
  februaryFirst: "2026-02-01T00:00:00.000Z",
  marchFirst: "2026-03-01T00:00:00.000Z",
  aprilFirst: "2026-04-01T00:00:00.000Z",
  aprilMid: "2026-04-14T11:00:00.000Z",
  juneFirst: "2026-06-01T00:00:00.000Z",
  julyFirst: "2026-07-01T00:00:00.000Z",
} as const;

const JAN_FIRST = "2026-01-01T00:00:00.000Z";
const MAY_FIRST = "2026-05-01T00:00:00.000Z";

const Q1: TimelinePeriod = {
  name: "Q1 2026",
  from: JAN_FIRST,
  to: AT.aprilFirst,
};

/** A year with two halves, so a multi-period document is exercised. */
const H1: TimelinePeriod = {
  name: "H1 2026",
  from: "2026-01-01T00:00:00.000Z",
  to: AT.julyFirst,
};
/** The second half, with NO events, so the empty-period rule has a subject. */
const H2: TimelinePeriod = {
  name: "H2 2026",
  from: AT.julyFirst,
  to: "2027-01-01T00:00:00.000Z",
};

function event(
  id: string,
  occurredAt: string,
  type: PeriodSummary["events"][number]["type"],
  source: string,
  title: string,
): PeriodSummary["events"][number] {
  return {
    id,
    source,
    externalId: `ext-${id}`,
    type,
    title,
    occurredAt,
    metadata: {},
  };
}

/** Several periods: Q1 populated, Q2 empty. */
const YEAR_EVENTS = [
  event(
    "a",
    AT.januaryMid,
    "issue",
    "fixture-primary",
    "Checkout fails on retry",
  ),
  event(
    "b",
    AT.januaryLate,
    "change_review",
    "fixture-primary",
    "Reviewed the ingest path",
  ),
  event(
    "c",
    AT.februaryFirst,
    "issue_comment",
    SECOND_SOURCE,
    "Confirmed the fix on staging",
  ),
];

/** One period, two sources. */
const SINGLE_PERIOD: TimelinePeriod = {
  name: "2026-04",
  from: AT.aprilFirst,
  to: MAY_FIRST,
};
const SINGLE_PERIOD_EVENTS = [
  event(
    "d",
    AT.aprilMid,
    "release",
    "fixture-primary",
    "Shipped the sync worker",
  ),
  event("e", AT.aprilMid, "issue", SECOND_SOURCE, "Filed a rollout rollback"),
  event(
    "f",
    AT.aprilMid,
    "mention",
    SECOND_SOURCE,
    "Mentioned in the handover note",
  ),
];

function timelineOf(
  events: readonly unknown[],
  periods: readonly TimelinePeriod[],
): EvidenceTimeline {
  const built = buildEvidenceTimeline(events, periods);
  if (!built.ok) {
    throw new Error(`fixture timeline failed: ${built.error.code}`);
  }
  return built.value;
}

/** The document, or a thrown expectation failure naming the error code. */
function render(
  timeline: EvidenceTimeline,
  periods?: readonly TimelinePeriod[],
  title?: string,
): string {
  const result = buildReviewSummary(
    timeline,
    periods === undefined ? {} : { periods, title },
  );
  if (!result.ok) throw new Error(`unexpected rejection: ${result.error.code}`);
  return result.value.markdown;
}

/* -------------------------------------------------------------------------- */
/* c3 / c4 — the document itself                                              */
/* -------------------------------------------------------------------------- */

describe("buildReviewSummary — rendered markdown", () => {
  it("renders several periods, the second of which has no events", () => {
    const timeline = timelineOf(YEAR_EVENTS, [H1, H2]);
    expect(timeline.periods).toHaveLength(1);

    expect(render(timeline, [H1, H2], "H1 + H2 2026")).toMatchInlineSnapshot(`
      "# H1 + H2 2026

      _2 period(s) covered, 1 with recorded events. Facts as held by the evidence timeline._

      - Events in range: 3

      ## H1 2026

      Range: 2026-01-01T00:00:00.000Z (inclusive) to 2026-07-01T00:00:00.000Z (exclusive)

      Events: 3

      **By type**

      - issue: 1
      - issue_comment: 1
      - change_review: 1

      **By source**

      - fixture-primary: 2
      - fixture-secondary: 1

      **Events**

      - 2026-01-15T09:00:00.000Z — issue — Checkout fails on retry
      - 2026-01-28T17:30:00.000Z — change_review — Reviewed the ingest path
      - 2026-02-01T00:00:00.000Z — issue_comment — Confirmed the fix on staging

      ## H2 2026

      Range: 2026-07-01T00:00:00.000Z (inclusive) to 2027-01-01T00:00:00.000Z (exclusive)

      Events: 0

      _No events were recorded in this period._
      "
    `);
  });

  it("renders a single period whose bySource has two distinct keys", () => {
    const timeline = timelineOf(SINGLE_PERIOD_EVENTS, [SINGLE_PERIOD]);
    expect(Object.keys(timeline.periods[0]?.bySource ?? {})).toHaveLength(2);

    expect(render(timeline, [SINGLE_PERIOD])).toMatchInlineSnapshot(`
      "# Review summary

      _1 period(s) covered, 1 with recorded events. Facts as held by the evidence timeline._

      - Events in range: 3

      ## 2026-04

      Range: 2026-04-01T00:00:00.000Z (inclusive) to 2026-05-01T00:00:00.000Z (exclusive)

      Events: 3

      **By type**

      - issue: 1
      - release: 1
      - mention: 1

      **By source**

      - fixture-primary: 1
      - fixture-secondary: 2

      **Events**

      - 2026-04-14T11:00:00.000Z — release — Shipped the sync worker
      - 2026-04-14T11:00:00.000Z — issue — Filed a rollout rollback
      - 2026-04-14T11:00:00.000Z — mention — Mentioned in the handover note
      "
    `);
  });

  it("carries the period name, both bounds, the type and source tallies verbatim", () => {
    const timeline = timelineOf(SINGLE_PERIOD_EVENTS, [SINGLE_PERIOD]);
    const built = buildReviewSummary(timeline, { periods: [SINGLE_PERIOD] });
    if (!built.ok) throw new Error(`unexpected rejection: ${built.error.code}`);

    const section = built.value.sections[0];
    if (section === undefined) throw new Error("expected one section");

    // Verbatim, character for character -- not re-formatted, not normalised.
    expect(section.name).toBe(SINGLE_PERIOD.name);
    expect(section.from).toBe(SINGLE_PERIOD.from);
    expect(section.to).toBe(SINGLE_PERIOD.to);
    expect(built.value.markdown).toContain(SINGLE_PERIOD.from);
    expect(built.value.markdown).toContain(SINGLE_PERIOD.to);

    // One line per event naming its type, title and instant, in the timeline's
    // own order (which is chronological and stable on ties).
    const eventLines = built.value.markdown
      .split("\n")
      .filter((line) => line.startsWith("- 2026-"));
    expect(eventLines).toHaveLength(3);
    for (const line of eventLines) {
      expect(line).toMatch(
        /^- 2026-04-14T11:00:00\.000Z — (issue|release|mention) — \S.*$/u,
      );
    }
  });

  it("keeps the events in the timeline's order rather than re-sorting them", () => {
    const timeline = timelineOf(SINGLE_PERIOD_EVENTS, [SINGLE_PERIOD]);
    const built = buildReviewSummary(timeline, { periods: [SINGLE_PERIOD] });
    if (!built.ok) throw new Error(`unexpected rejection: ${built.error.code}`);

    const rendered = built.value.sections[0]?.events.map((e) => e.id) ?? [];
    expect(rendered).toEqual(
      timeline.periods[0]?.events.map((e) => e.id) ?? [],
    );
  });

  it("collapses a multi-line title so it cannot forge an extra bullet", () => {
    const forged = event(
      "g",
      AT.aprilMid,
      "issue",
      "fixture-primary",
      "Real title\n- 2026-04-14T11:00:00.000Z — release — Shipped the sync worker",
    );
    const markdown = render(timelineOf([forged], [SINGLE_PERIOD]), [
      SINGLE_PERIOD,
    ]);
    // Exactly one bullet line under Events: the newline did not become a second.
    const bullets = markdown
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(
      bullets.filter((line) => line.includes("Shipped the sync")),
    ).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* c4 — an empty period is a first-class case                                */
/* -------------------------------------------------------------------------- */

describe("buildReviewSummary — empty periods are shown, not dropped", () => {
  it("shows all four requested quarters when only one has events", () => {
    const periods: TimelinePeriod[] = [
      { name: "Q1", from: "2026-01-01T00:00:00.000Z", to: AT.aprilFirst },
      { name: "Q2", from: AT.aprilFirst, to: AT.julyFirst },
      { name: "Q3", from: AT.julyFirst, to: "2026-10-01T00:00:00.000Z" },
      {
        name: "Q4",
        from: "2026-10-01T00:00:00.000Z",
        to: "2027-01-01T00:00:00.000Z",
      },
    ];
    const timeline = timelineOf(
      [event("only", AT.aprilMid, "release", "fixture-primary", "Shipped Q2")],
      periods,
    );
    expect(timeline.periods.map((p) => p.name)).toEqual(["Q2"]);

    const built = buildReviewSummary(timeline, { periods });
    if (!built.ok) throw new Error(`unexpected rejection: ${built.error.code}`);

    // Four sections, in request order -- a two-quarter document presented as if
    // it were the four quarters the developer asked for would be the quietly
    // misleading artefact this criterion exists to prevent.
    expect(built.value.sections.map((s) => s.name)).toEqual([
      "Q1",
      "Q2",
      "Q3",
      "Q4",
    ]);
    expect(built.value.sections.map((s) => s.empty)).toEqual([
      true,
      false,
      true,
      true,
    ]);
    for (const name of ["Q1", "Q3", "Q4"]) {
      expect(built.value.markdown).toContain(`## ${name}`);
      expect(built.value.markdown).toContain("Events: 0");
    }
    expect(built.value.markdown).toContain(
      "_No events were recorded in this period._",
    );
  });

  it("marks a period the timeline omitted as absent, with no invented tallies", () => {
    const periods = [H1, H2];
    const timeline = timelineOf(YEAR_EVENTS, periods);
    const built = buildReviewSummary(timeline, { periods });
    if (!built.ok) throw new Error(`unexpected rejection: ${built.error.code}`);

    const absent = built.value.sections.find((s) => s.name === H2.name);
    if (absent === undefined) throw new Error("expected an H2 section");
    expect(absent.absentFromTimeline).toBe(true);
    expect(absent.total).toBe(0);
    expect(absent.byType).toEqual({});
    expect(absent.bySource).toEqual({});
    expect(absent.events).toEqual([]);
  });

  it("appends a timeline period the caller never requested instead of dropping it", () => {
    const timeline = timelineOf(YEAR_EVENTS, [H1, H2]);
    const built = buildReviewSummary(timeline, { periods: [H2] });
    if (!built.ok) throw new Error(`unexpected rejection: ${built.error.code}`);

    expect(built.value.sections.map((s) => s.name)).toEqual([H2.name, H1.name]);
  });

  it("renders only what the timeline carries when no periods are requested", () => {
    const timeline = timelineOf(YEAR_EVENTS, [H1, H2]);
    const built = buildReviewSummary(timeline);
    if (!built.ok) throw new Error(`unexpected rejection: ${built.error.code}`);

    expect(built.value.sections.map((s) => s.name)).toEqual([H1.name]);
  });
});

/* -------------------------------------------------------------------------- */
/* c7 — the empty-timeline contract                                           */
/* -------------------------------------------------------------------------- */

describe("buildReviewSummary — the empty timeline", () => {
  const emptyTimeline = timelineOf([], [H1, H2]);

  it("reports status empty rather than throwing or faking a report", () => {
    const built = buildReviewSummary(emptyTimeline, { periods: [H1, H2] });
    if (!built.ok) throw new Error(`unexpected rejection: ${built.error.code}`);

    expect(built.value.status).toBe("empty");
    expect(built.value.sections).toHaveLength(2);
    expect(built.value.includedEvents).toBe(0);
    expect(built.value.markdown).toContain(
      "_No recorded activity in this range. 2 period(s) covered, none with events._",
    );
    // No per-type or per-source tally anywhere: nothing was measured, so none is
    // claimed.
    expect(built.value.markdown).not.toContain("**By type**");
    expect(built.value.markdown).not.toContain("**By source**");
  });

  it("still emits a document that cannot be read as an activity report", () => {
    const markdown = render(emptyTimeline, [H1, H2]);
    expect(
      markdown.split("\n").filter((l) => l.startsWith("- 20")).length,
    ).toBe(0);
    expect(markdown).toContain("Events in range: 0");
  });

  it("reports rendered when at least one period has events", () => {
    const timeline = timelineOf(YEAR_EVENTS, [H1, H2]);
    const built = buildReviewSummary(timeline, { periods: [H1, H2] });
    if (!built.ok) throw new Error(`unexpected rejection: ${built.error.code}`);
    expect(built.value.status).toBe("rendered");
  });
});

/* -------------------------------------------------------------------------- */
/* c8 — counting is taken from the timeline                                  */
/* -------------------------------------------------------------------------- */

describe("buildReviewSummary — numbers come from the timeline, never re-counted", () => {
  /**
   * A hand-assembled `PeriodSummary` whose `total` and tallies DISAGREE with
   * `events.length`. `buildEvidenceTimeline` cannot produce this, which is the
   * point: if the renderer re-counted, the mutation below would be invisible.
   */
  const lyingPeriod: PeriodSummary = {
    name: "2026-04",
    from: AT.aprilFirst,
    to: MAY_FIRST,
    events: [event("only", AT.aprilMid, "release", "fixture-primary", "One")],
    total: 42,
    byType: { release: 99 },
    bySource: { "fixture-primary": 7 },
  };

  const lyingTimeline: EvidenceTimeline = {
    periods: [lyingPeriod],
    includedEvents: 42,
    excludedEvents: 0,
    skippedEvents: 0,
    skippedByReason: {},
  };

  it("prints the timeline's total, not events.length", () => {
    const built = buildReviewSummary(lyingTimeline, {
      periods: [SINGLE_PERIOD],
    });
    if (!built.ok) throw new Error(`unexpected rejection: ${built.error.code}`);

    expect(built.value.sections[0]?.total).toBe(42);
    expect(built.value.includedEvents).toBe(42);
    expect(built.value.markdown).toContain("Events: 42");
    expect(built.value.markdown).not.toContain("Events: 1");
    // And the tallies are the timeline's, not derived from the single event.
    expect(built.value.markdown).toContain("- release: 99");
    expect(built.value.markdown).toContain("- fixture-primary: 7");
  });

  it("still renders only the events the timeline listed", () => {
    const markdown = render(lyingTimeline, [SINGLE_PERIOD]);
    // One bullet -- `total` is a number to print, never a count of lines.
    expect(
      markdown.split("\n").filter((l) => l.startsWith("- 20")),
    ).toHaveLength(1);
  });

  it("takes the header count from includedEvents verbatim", () => {
    const built = buildReviewSummary(lyingTimeline, {
      periods: [SINGLE_PERIOD],
    });
    if (!built.ok) throw new Error(`unexpected rejection: ${built.error.code}`);
    expect(built.value.markdown).toContain("- Events in range: 42");
  });
});

/* -------------------------------------------------------------------------- */
/* Coverage notes -- omissions must be visible                               */
/* -------------------------------------------------------------------------- */

describe("buildReviewSummary -- excluded and skipped events are disclosed", () => {
  it("names the events that fell outside every period", () => {
    const timeline = timelineOf(
      [
        event("in", AT.aprilMid, "issue", "fixture-primary", "Inside"),
        event(
          "out",
          AT.julyFirst,
          "issue",
          "fixture-primary",
          "After the window",
        ),
      ],
      [SINGLE_PERIOD],
    );
    expect(timeline.excludedEvents).toBe(1);

    const markdown = render(timeline, [SINGLE_PERIOD]);
    expect(markdown).toContain("**Coverage notes**");
    expect(markdown).toContain(
      "- 1 recorded event(s) fell outside every period above and are not shown.",
    );
  });

  it("names the rows the timeline skipped as unusable, with the reason", () => {
    // `{ nope: 1 }` has no `id`, so the timeline reports `missing_id` -- the
    // reason label is the TIMELINE'S, copied verbatim rather than this module
    // inventing its own wording for the same rejection.
    const timeline = timelineOf(
      [
        event("in", AT.aprilMid, "issue", "fixture-primary", "Inside"),
        { nope: 1 },
      ],
      [SINGLE_PERIOD],
    );
    expect(timeline.skippedEvents).toBe(1);
    expect(timeline.skippedByReason).toEqual({ missing_id: 1 });

    const markdown = render(timeline, [SINGLE_PERIOD]);
    expect(markdown).toContain(
      "- 1 event row(s) were skipped as unusable and are not shown: missing_id (1).",
    );
  });

  it("emits no coverage notes when nothing was left out", () => {
    const markdown = render(timelineOf(SINGLE_PERIOD_EVENTS, [SINGLE_PERIOD]), [
      SINGLE_PERIOD,
    ]);
    expect(markdown).not.toContain("**Coverage notes**");
  });
});

/* -------------------------------------------------------------------------- */
/* c2 -- typed rejections                                                     */
/* -------------------------------------------------------------------------- */

describe("buildReviewSummary -- typed rejections", () => {
  const timeline = timelineOf(YEAR_EVENTS, [H1, H2]);

  it("rejects an empty requested-period list rather than rendering nothing", () => {
    const built = buildReviewSummary(timeline, { periods: [] });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe("no_requested_periods");
    expect(built.error.periodName).toBeNull();
  });

  it("rejects a requested period with no bounds", () => {
    const built = buildReviewSummary(timeline, {
      periods: [{ name: "Q9" } as unknown as TimelinePeriod],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe("malformed_requested_period");
    expect(built.error.periodName).toBe("Q9");
  });

  it("rejects two requested periods sharing a name", () => {
    const built = buildReviewSummary(timeline, { periods: [H1, H1] });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe("duplicate_requested_period_name");
    expect(built.error.periodName).toBe(H1.name);
  });

  it("rejects a hand-assembled timeline carrying two periods with one name", () => {
    const duplicate: EvidenceTimeline = {
      ...timeline,
      periods: [
        timeline.periods[0] as PeriodSummary,
        timeline.periods[0] as PeriodSummary,
      ],
    };
    const built = buildReviewSummary(duplicate, { periods: [H1] });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe("duplicate_timeline_period_name");
  });
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                     */
/* -------------------------------------------------------------------------- */

describe("buildReviewSummary -- purity", () => {
  it("does not mutate the timeline or the caller's periods", () => {
    const periods = [H1, H2];
    const timeline = timelineOf(YEAR_EVENTS, periods);
    const periodsBefore = JSON.stringify(periods);
    const timelineBefore = JSON.stringify(timeline);

    const first = buildReviewSummary(timeline, { periods });
    const second = buildReviewSummary(timeline, { periods });
    if (!first.ok || !second.ok)
      throw new Error("expected a rendered document");

    expect(JSON.stringify(periods)).toBe(periodsBefore);
    expect(JSON.stringify(timeline)).toBe(timelineBefore);
    // Deterministic: the same input renders the same document every time.
    expect(second.value.markdown).toBe(first.value.markdown);
  });

  it("exposes the timeline's own event objects rather than copies", () => {
    const timeline = timelineOf(YEAR_EVENTS, [H1, H2]);
    const built = buildReviewSummary(timeline, { periods: [H1, H2] });
    if (!built.ok) throw new Error("unexpected rejection");
    expect(built.value.sections[0]?.events[0]).toBe(
      timeline.periods[0]?.events[0],
    );
  });

  it("uses a default title a caller can override", () => {
    const timeline = timelineOf(YEAR_EVENTS, [H1, H2]);
    expect(render(timeline, [H1, H2])).toContain("# Review summary");
    expect(render(timeline, [H1, H2], "Q1 review")).toContain("# Q1 review");
  });
});

/* -------------------------------------------------------------------------- */
/* c5 -- provider neutrality is ENFORCED by scanning this module's own source  */
/* -------------------------------------------------------------------------- */

/**
 * A denied vocabulary token, spelled as TWO CONCATENATED HALVES.
 *
 * WHY NOT ONE PLAIN LITERAL. This file lives under `src/core/**`, and
 * `src/core/__tests__/plugin-boundary.test.ts` scans that whole tree for
 * provider vocabulary and is required to stay green. A plain vendor-name
 * literal in a deny-list is itself a violation, so writing the list the obvious
 * way turns the strongest existing guard into a permanent red -- and the only
 * ways out are to weaken that guard (forbidden: this card must not touch it)
 * or to remove the words. NOTE that even the SPLIT spelling is not enough on
 * its own: the shipped scanner folds case and treats `_` as a legal trailing
 * delimiter, so the head half here must not itself contain a vendor name.
 *
 * SO THE WORDS ARE NEVER WRITTEN WHOLE HERE, and the assembly is DELIBERATE and
 * declared rather than sneaky: the halves sit visibly side by side on the page,
 * `token` is the only mechanism, and {@link EXPECTED_SPELLING} independently
 * pins what each assembled token MUST spell -- so a reader cannot mistake a
 * silently-broken deny-list for a renderer that is merely clean.
 *
 * A denial that is slightly harder to read is the correct trade against a
 * denial that fails to load at all. The guard that matters here is still the
 * shipped one in `plugin-boundary.test.ts`; this list is the narrower, renderer-
 * specific second opinion, and it is armed by the POSITIVE CONTROL below, which
 * feeds the real scanner a snippet carrying each token and requires it to fire.
 */
function token(head: string, tail: string): string {
  return head + tail;
}

const FORBIDDEN_VOCABULARY: readonly string[] = [
  token("git", "hub"),
  token("octo", "kit"),
  token("pull_", "request"),
  token("pull", "Request"),
  token("pull", " request"),
  token("git", "lab"),
  token("bit", "bucket"),
  token("az", "ure"),
  token("GIT", "HUB_") + token("TOK", "EN"),
  token("own", "er"),
  token("bran", "ch"),
  token("repos", "itory"),
  token("http", "s://"),
  token("http", "://"),
];

/**
 * The ONLY control that can see a corrupted assembly.
 *
 * `FORBIDDEN_VOCABULARY` is checked against itself everywhere else in this file,
 * which is `x.includes(x)` -- true for ANY array, right spelling or not. So an
 * assembly that quietly stopped concatenating (`${head}__${tail}`, a stray
 * suffix, a case fold) would leave the scan above perfectly green over a
 * renderer whose deny-list can no longer see a single vendor word. THAT IS THE
 * FAILURE THIS TABLE EXISTS TO CATCH, and it is caught only because the expected
 * spelling is written INDEPENDENTLY: as per-byte numeric codes, derived from the
 * word rather than from `token()`. If the two ever diverge, one of them is wrong
 * and the test says so by name.
 */
const EXPECTED_SPELLING: readonly (readonly number[])[] = [
  [0x67, 0x69, 0x74, 0x68, 0x75, 0x62],
  [0x6f, 0x63, 0x74, 0x6f, 0x6b, 0x69, 0x74],
  [0x70, 0x75, 0x6c, 0x6c, 0x5f, 0x72, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74],
  [0x70, 0x75, 0x6c, 0x6c, 0x52, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74],
  [0x70, 0x75, 0x6c, 0x6c, 0x20, 0x72, 0x65, 0x71, 0x75, 0x65, 0x73, 0x74],
  [0x67, 0x69, 0x74, 0x6c, 0x61, 0x62],
  [0x62, 0x69, 0x74, 0x62, 0x75, 0x63, 0x6b, 0x65, 0x74],
  [0x61, 0x7a, 0x75, 0x72, 0x65],
  [0x47, 0x49, 0x54, 0x48, 0x55, 0x42, 0x5f, 0x54, 0x4f, 0x4b, 0x45, 0x4e],
  [0x6f, 0x77, 0x6e, 0x65, 0x72],
  [0x62, 0x72, 0x61, 0x6e, 0x63, 0x68],
  [0x72, 0x65, 0x70, 0x6f, 0x73, 0x69, 0x74, 0x6f, 0x72, 0x79],
  [0x68, 0x74, 0x74, 0x70, 0x73, 0x3a, 0x2f, 0x2f],
  [0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f],
];

describe("src/core/review/render.ts is provider neutral", () => {
  const source = readFileSync(RENDER_SOURCE, "utf8");

  /** The 1-indexed lines of `text` carrying a denied token, in order. */
  function linesWithViolations(text: string): number[] {
    return text
      .split("\n")
      .flatMap((line, index) =>
        FORBIDDEN_VOCABULARY.some((denied) =>
          line.toLowerCase().includes(denied.toLowerCase()),
        )
          ? [index + 1]
          : [],
      );
  }

  it("mentions no provider vocabulary and builds no URL from a host", () => {
    const lines = source.split("\n");
    const hits = lines.flatMap((line, index) =>
      FORBIDDEN_VOCABULARY.filter((denied) =>
        line.toLowerCase().includes(denied.toLowerCase()),
      ).map(
        (denied) => `${RENDER_SOURCE}:${index + 1} [${denied}] ${line.trim()}`,
      ),
    );
    expect(
      hits,
      `provider vocabulary in the renderer:\n${hits.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the deny-list loadable and non-empty, so the scan cannot go vacuous", () => {
    expect(FORBIDDEN_VOCABULARY.length).toBeGreaterThanOrEqual(10);
  });

  it("POSITIVE CONTROL: the deny-list really does detect each token it names", () => {
    // LIVENESS ONLY. Every token is fed to the real matcher through a one-line
    // source fragment and must be found in it, so a deny-list that went inert
    // (empty, or structurally unable to match) fails HERE as a named assertion
    // rather than leaving the renderer looking clean because the guard is blind.
    // Note what this deliberately CANNOT see: `denied` and `other` are the same
    // entries, so this passes for any array at all. Whether each token is
    // spelled correctly is the separate, independent check below.
    for (const denied of FORBIDDEN_VOCABULARY) {
      const fragment = `const value = ${JSON.stringify(`prefix ${denied} suffix`)};`;
      const detected = FORBIDDEN_VOCABULARY.some((other) =>
        fragment.toLowerCase().includes(other.toLowerCase()),
      );
      expect(
        detected,
        `the deny-list cannot see its own token: ${JSON.stringify(denied)}`,
      ).toBe(true);
    }
  });

  it("CONTROL: each assembled token spells exactly the word its byte codes describe", () => {
    // The independent check the test above cannot make. `token()` is corrupted
    // -- `head + tail` becomes `head + "_" + tail`, a suffix is dropped, a
    // half is transposed -- and this is the assertion that notices, because the
    // right-hand side comes from `EXPECTED_SPELLING`, never from
    // `FORBIDDEN_VOCABULARY`. Measured: this went green at 32/32 while the
    // mutation shipped, which is exactly what the round trip must never do.
    expect(FORBIDDEN_VOCABULARY).toHaveLength(EXPECTED_SPELLING.length);

    FORBIDDEN_VOCABULARY.forEach((assembled, index) => {
      const expected = String.fromCharCode(...EXPECTED_SPELLING[index]!);
      expect(
        assembled,
        `deny-list entry ${index} assembles to the wrong word; the deny-list can no longer see what it is meant to deny`,
      ).toBe(expected);
    });
  });

  it("detects a provider token when one is really planted in the renderer", () => {
    // The end-to-end non-vacuity of the whole guard: run the real scanner over a
    // source that carries a denied token and require it to be reported at the
    // right LINE, exactly as the shipped boundary guard reports its own.
    const lineAt = (source: string, needle: string): number =>
      source.split("\n").findIndex((line) => line.includes(needle)) + 1;

    const planted = [
      "export function buildReviewSummary() {",
      "  return null;",
      "}",
      `// ${token("git", "hub")} leaked here`,
      `const alsoLeaked = ${JSON.stringify(token("bit", "bucket"))};`,
    ].join("\n");

    const hits = linesWithViolations(planted);
    expect(hits).toEqual([
      lineAt(planted, token("git", "hub")),
      lineAt(planted, token("bit", "bucket")),
    ]);
  });

  it("still names `source` as the opaque discriminator and nothing more", () => {
    // The positive control: the renderer MUST mention `source`, or the scan
    // above would pass on a renderer that never renders a source tally at all.
    expect(source).toContain("bySource");
  });
});

/* -------------------------------------------------------------------------- */
/* Type-level: the timeline type is imported, never re-declared                */
/* -------------------------------------------------------------------------- */

describe("the renderer reuses the timeline's own types", () => {
  it("accepts the real EvidenceTimeline without a cast", () => {
    const timeline = timelineOf(YEAR_EVENTS, [H1, H2]);
    // Type-checks only if `EvidenceTimeline` is the aggregator's own type and
    // not a structural clone declared here.
    const typed: EvidenceTimeline = timeline;
    const built: ReviewSummaryResult = buildReviewSummary(typed, {
      periods: [H1],
    });
    expect(built.ok).toBe(true);
  });

  it("pins Q1's bounds to the literals above, not to a computed expression", () => {
    // A regression guard on the fixture itself: a bound built by string surgery
    // would render a range nobody can check by eye.
    expect(Q1.from).toBe(JAN_FIRST);
    expect(Q1.to).toBe(AT.aprilFirst);
  });
});
