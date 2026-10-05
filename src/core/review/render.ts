/**
 * Provider-neutral review-summary renderer.
 *
 * Turns an already-built {@link EvidenceTimeline} into the review-ready period
 * document: the markdown a developer pastes into a performance review, plus a
 * typed structured result a page can render without re-parsing the text
 * (project charter §3 objective 3, "Review-ready output"; the v1 in-scope item
 * "Period summary generator"). The aggregation it reads is
 * `src/core/evidence/timeline.ts`, which is ON `origin/main` and is NOT edited
 * or re-declared here: `EvidenceTimeline`, `PeriodSummary`, `TimelinePeriod`,
 * `EventTypeCounts` and `EventSourceCounts` are imported from that module's
 * public surface, so the two cannot drift.
 *
 * PURE BY CONSTRUCTION, for the same reasons `timeline.ts` is: no I/O, no
 * database, no network, no plugin import, no `Date.now()`, no `Math.random()`, no
 * ambient clock. Every instant in the output is a string the timeline already
 * carried, copied verbatim. There is no page, no route and no composition-root
 * wiring in this module — it is a library with a tested surface, and wiring it
 * into the app is a separate card (the wiring is exactly what would smuggle a
 * provider concept upward, so it must be reviewed separately).
 *
 * NO NARRATIVE IS GENERATED. This module renders facts the database already
 * holds: counts, bounds, timestamps and titles. It does not write prose about
 * impact, does not rank anything and does not infer sentiment. A review document
 * that paraphrases a developer's work is an opinion wearing the costume of a
 * report; this deliberately cannot produce one.
 *
 * PROVIDER NEUTRALITY (60-agent-briefs.md hard rule 1). `source` is rendered as
 * the opaque discriminator the database holds — the same treatment `timeline.ts`
 * gives it, and the same treatment the evidence page gives it. There is no
 * provider enum, no vendor vocabulary and no host-derived URL anywhere in this
 * module, and
 * `src/core/review/__tests__/review-summary.test.ts` scans this file's own
 * source for that vocabulary so the property is enforced rather than asserted in
 * a comment.
 *
 * THREE THINGS THIS RENDERER REFUSES TO DO, each of which is a way the artefact
 * becomes quietly wrong rather than obviously broken:
 *
 *  1. IT NEVER DROPS A REQUESTED PERIOD. `EvidenceTimeline.periods` OMITS a
 *     period with no events — deliberately, because "absent" must mean one thing
 *     in that module. But a review document that quietly showed two quarters
 *     when the developer asked for four would be indistinguishable from a
 *     two-quarter review, and nobody reading it would check. So the caller's
 *     requested periods are passed in
 *     ({@link ReviewSummaryOptions.periods}) and every one of them appears in
 *     the document, labelled as empty when the timeline omitted it.
 *  2. IT NEVER RE-COUNTS. `PeriodSummary.total`, `byType` and `bySource` are
 *     printed as the timeline states them. If a future aggregation disagrees
 *     with itself, the page and the document must disagree IDENTICALLY and
 *     visibly, rather than the document quietly re-deriving a number that looks
 *     authoritative. This is asserted by a test that hands the renderer a
 *     `PeriodSummary` whose `total` deliberately disagrees with `events.length`.
 *  3. IT NEVER THROWS. An empty timeline is a normal state — the developer has
 *     not captured anything yet — not an error. See
 *     {@link ReviewSummaryStatus} / `ReviewSummaryDocument["status"]`.
 */

import type {
  EventSourceCounts,
  EventTypeCounts,
  EvidenceTimeline,
  PeriodSummary,
  TimelinePeriod,
} from "@/core/evidence";
import type { CanonicalEvent } from "@/core/events/canonical-event";

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Typed error codes, following the one convention core already has
 * (`TimelineErrorCode` in `src/core/evidence/timeline.ts`, `RegistryErrorCode`
 * in `src/core/plugins/registry.ts`): a rejected call returns `{ ok: false,
 * error }` with a stable `code`, never a thrown-and-caught string.
 *
 * Note WHAT is not here: there is no code for an empty timeline and none for a
 * period with no events. Those are the states the document must report, not
 * failures — see criterion 3 in this file's header.
 */
export const REVIEW_SUMMARY_ERROR_CODES = [
  /** `options.periods` was an empty array, so there was nothing to render. */
  "no_requested_periods",
  /**
   * A requested period was not an object with non-empty `name`, `from` and `to`
   * strings. The renderer cannot print bounds it was not given, and printing a
   * blank range in a review document would be worse than refusing.
   */
  "malformed_requested_period",
  /** Two requested periods share a name, so their sections would be ambiguous. */
  "duplicate_requested_period_name",
  /**
   * Two entries of `timeline.periods` share a name. `buildEvidenceTimeline`
   * cannot produce this, so it is a caller that hand-assembled the timeline
   * rather than a bug in that module — and it would silently drop one of them.
   */
  "duplicate_timeline_period_name",
] as const;

export type ReviewSummaryErrorCode =
  (typeof REVIEW_SUMMARY_ERROR_CODES)[number];

/** Machine-readable, non-secret description of a rejected call. */
export interface ReviewSummaryError {
  readonly code: ReviewSummaryErrorCode;
  /** The offending period's name when attributable; `null` when not. */
  readonly periodName: string | null;
  /** Human-readable explanation. Carries no event data and no caller secrets. */
  readonly message: string;
}

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What the document says about the range it covers.
 *
 * `"empty"` is the c7 contract, named rather than left to fall out: it means
 * `timeline.periods` carried no period with any events. The document then opens
 * by saying so in plain words and renders every requested period as explicitly
 * empty, so it cannot be mistaken for a report about a period in which nothing
 * was found. It is NOT a full report and does not look like one. `"rendered"`
 * means at least one period carried events.
 */
export const REVIEW_SUMMARY_STATUSES = ["empty", "rendered"] as const;

export type ReviewSummaryStatus = (typeof REVIEW_SUMMARY_STATUSES)[number];

/**
 * One period's block of the document.
 *
 * `total`, `byType` and `bySource` are the timeline's numbers, copied. When the
 * timeline omitted the period because it held no events, they are the empty
 * tallies below and `total` is `0` — there was nothing to take them from, and
 * the section says so in words rather than implying a measurement happened.
 */
export interface ReviewSummarySection {
  /** The caller's label for the period, verbatim. */
  readonly name: string;
  /** Inclusive lower bound, verbatim. */
  readonly from: string;
  /** Exclusive upper bound, verbatim. */
  readonly to: string;
  /** `PeriodSummary.total` as the timeline stated it; `0` for an empty period. */
  readonly total: number;
  /** `PeriodSummary.byType` as the timeline stated it; empty for an empty period. */
  readonly byType: EventTypeCounts;
  /** `PeriodSummary.bySource` as the timeline stated it; empty for an empty period. */
  readonly bySource: EventSourceCounts;
  /**
   * The period's events in the timeline's own chronological order, as the very
   * same `CanonicalEvent` objects — never re-declared and never re-sorted.
   */
  readonly events: readonly CanonicalEvent[];
  /** True when no events were recorded in this period. */
  readonly empty: boolean;
  /**
   * True when the TIMELINE omitted this period (it held no events), as opposed
   * to the caller simply not asking for it. The document labels both as empty;
   * this flag is for a caller rendering the sections programmatically.
   */
  readonly absentFromTimeline: boolean;
}

export interface ReviewSummaryOptions {
  /**
   * The periods the caller asked for, in the order the document must show them.
   *
   * This is the whole reason an empty period can appear at all:
   * `buildEvidenceTimeline` drops empty periods from its result, so the request
   * has to be repeated here for the document to be able to answer it. Pass the
   * SAME array you passed to `buildEvidenceTimeline` — the renderer matches by
   * `name`, so a name that differs simply shows as empty rather than throwing.
   *
   * When omitted, the renderer falls back to `timeline.periods` and cannot show
   * a period the timeline omitted, because it was never told about one.
   */
  readonly periods?: readonly TimelinePeriod[];
  /** Document heading. Defaults to `"Review summary"`. Not provider-specific. */
  readonly title?: string;
}

/** The rendered document. */
export interface ReviewSummaryDocument {
  /** See {@link ReviewSummaryStatus}. The c7 empty-timeline contract. */
  readonly status: ReviewSummaryStatus;
  /** The paste-ready markdown. Empty-free: always at least one non-blank line. */
  readonly markdown: string;
  /** One section per period in document order. Never shorter than requested. */
  readonly sections: readonly ReviewSummarySection[];
  /**
   * `EvidenceTimeline.includedEvents` verbatim, so the document's headline count
   * is the aggregation's own and not a re-count. Note it is a PER-PERIOD sum:
   * two overlapping periods count a shared event twice, by the timeline's
   * documented choice.
   */
  readonly includedEvents: number;
}

/** Result of a fallible call. Mirrors `TimelineResult<T>`. */
export type ReviewSummaryResult =
  | { readonly ok: true; readonly value: ReviewSummaryDocument }
  | { readonly ok: false; readonly error: ReviewSummaryError };

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

type Rejected = { readonly ok: false; readonly error: ReviewSummaryError };

function reject(
  code: ReviewSummaryErrorCode,
  periodName: string | null,
  message: string,
): Rejected {
  return { ok: false, error: { code, periodName, message } };
}

/**
 * A rejected period's name when it has a usable one, else `null`.
 *
 * A separate function because the narrowing in {@link isPeriodShape} means the
 * caller is holding a value TypeScript has proved is NOT a `TimelinePeriod` --
 * and `period.name` on that value is a type error, not merely awkward. The name
 * is read through an unknown-typed local so the error message can still point at
 * the offending period instead of at "some element of the array".
 */
function offendingName(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = (value as { name?: unknown }).name;
  return typeof candidate === "string" && candidate.trim() !== ""
    ? candidate
    : null;
}

function isPeriodShape(value: unknown): value is TimelinePeriod {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<Record<keyof TimelinePeriod, unknown>>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.trim() !== "" &&
    typeof candidate.from === "string" &&
    candidate.from.trim() !== "" &&
    typeof candidate.to === "string" &&
    candidate.to.trim() !== ""
  );
}

/**
 * Validate `options.periods`, returning fresh copies so the caller's array and
 * its objects are never aliased into the result.
 *
 * The bounds are NOT re-validated as ISO-8601: this module never parses an
 * instant (it does not order, compare or format anything), so a bound it did not
 * need to understand is not a bound it should reject. It prints what it was
 * given, which is also why the rendered text can never disagree with the
 * timeline about a boundary.
 */
type ValidatedPeriods =
  | { readonly ok: true; readonly value: readonly TimelinePeriod[] }
  | Rejected;

function validateRequestedPeriods(
  periods: readonly TimelinePeriod[] | undefined,
): ValidatedPeriods {
  if (periods === undefined) return { ok: true, value: [] };
  if (periods.length === 0) {
    return reject(
      "no_requested_periods",
      null,
      "options.periods was empty; pass the same periods you asked the timeline for, or omit the option entirely.",
    );
  }

  const seen = new Set<string>();
  const copies: TimelinePeriod[] = [];
  for (const period of periods) {
    if (!isPeriodShape(period)) {
      return reject(
        "malformed_requested_period",
        offendingName(period),
        "A requested period must be an object with non-empty name, from and to strings.",
      );
    }
    if (seen.has(period.name)) {
      return reject(
        "duplicate_requested_period_name",
        period.name,
        `Two requested periods are named "${period.name}"; their sections would be ambiguous.`,
      );
    }
    seen.add(period.name);
    copies.push({ name: period.name, from: period.from, to: period.to });
  }
  return { ok: true, value: copies };
}

/**
 * Index `timeline.periods` by name.
 *
 * A duplicate is an ERROR rather than a first-wins merge: the timeline's own
 * builder cannot produce one, so it means a hand-assembled timeline, and
 * silently keeping the first would drop a whole period from a document whose
 * entire purpose is to be complete.
 */
function indexTimelinePeriods(
  timeline: EvidenceTimeline,
):
  | { readonly ok: true; readonly value: ReadonlyMap<string, PeriodSummary> }
  | Rejected {
  const index = new Map<string, PeriodSummary>();
  for (const period of timeline.periods) {
    if (index.has(period.name)) {
      return reject(
        "duplicate_timeline_period_name",
        period.name,
        `The timeline carries two periods named "${period.name}".`,
      );
    }
    index.set(period.name, period);
  }
  return { ok: true, value: index };
}

/* -------------------------------------------------------------------------- */
/* Section assembly                                                           */
/* -------------------------------------------------------------------------- */

function sectionFrom(period: PeriodSummary): ReviewSummarySection {
  return {
    name: period.name,
    from: period.from,
    to: period.to,
    total: period.total,
    byType: period.byType,
    bySource: period.bySource,
    events: period.events,
    empty: period.events.length === 0,
    absentFromTimeline: false,
  };
}

/** A requested period the timeline omitted. Nothing was measured, so nothing is claimed. */
function emptySection(period: TimelinePeriod): ReviewSummarySection {
  return {
    name: period.name,
    from: period.from,
    to: period.to,
    total: 0,
    byType: {},
    bySource: {},
    events: [],
    empty: true,
    absentFromTimeline: true,
  };
}

/**
 * One section per requested period, in request order.
 *
 * A timeline period the caller did not ask for is APPENDED rather than dropped,
 * after the requested ones and in the timeline's own order. It cannot happen
 * through `buildEvidenceTimeline` (it only ever summarises requested periods),
 * but silently discarding supplied data is the failure mode this module exists
 * to avoid, so the unexpected case is visible in the document instead of absent
 * from it.
 */
function assembleSections(
  requested: readonly TimelinePeriod[],
  timeline: EvidenceTimeline,
  index: ReadonlyMap<string, PeriodSummary>,
): ReviewSummarySection[] {
  const sections: ReviewSummarySection[] = [];
  const used = new Set<string>();

  for (const period of requested) {
    const summary = index.get(period.name);
    if (summary === undefined) {
      sections.push(emptySection(period));
      continue;
    }
    used.add(period.name);
    sections.push(sectionFrom(summary));
  }

  for (const period of timeline.periods) {
    if (used.has(period.name)) continue;
    sections.push(sectionFrom(period));
  }

  return sections;
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Collapse a value to ONE line.
 *
 * Every interpolated value here is database-sourced text, and a title carrying
 * a newline would otherwise be able to forge a second bullet and impersonate an
 * event the database does not hold — the renderer would be writing a claim it
 * cannot source. Collapsing is the narrow fix; the value is otherwise printed
 * verbatim, because a review document must quote titles as they are.
 */
function inline(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function renderTally(
  label: string,
  entries: readonly (readonly [string, number])[],
): string[] {
  const lines = [`**${label}**`, ""];
  if (entries.length === 0) {
    lines.push("- _none recorded_");
    return lines;
  }
  for (const [key, count] of entries) lines.push(`- ${inline(key)}: ${count}`);
  return lines;
}

function renderSection(section: ReviewSummarySection): string[] {
  const lines: string[] = [];
  lines.push(`## ${inline(section.name)}`, "");
  lines.push(
    `Range: ${section.from} (inclusive) to ${section.to} (exclusive)`,
    "",
  );
  lines.push(`Events: ${section.total}`, "");

  if (section.empty) {
    lines.push("_No events were recorded in this period._", "");
    return lines;
  }

  lines.push(...renderTally("By type", Object.entries(section.byType)), "");
  lines.push(...renderTally("By source", Object.entries(section.bySource)), "");

  lines.push("**Events**", "");
  for (const event of section.events) {
    lines.push(
      `- ${event.occurredAt} — ${event.type} — ${inline(event.title)}`,
    );
  }

  lines.push("");
  return lines;
}

/**
 * Render the whole document.
 *
 * The header states how many periods were covered and how many of them actually
 * held events BEFORE the first section, so a reader learns the shape of the
 * period before reading a single bullet. When nothing was recorded, the header
 * is the whole story and the sections are empty blocks — which is what keeps a
 * no-activity document from reading as an activity report.
 */
function renderDocument(
  sections: readonly ReviewSummarySection[],
  timeline: EvidenceTimeline,
  title: string,
  status: ReviewSummaryStatus,
): string {
  const populated = sections.filter((section) => !section.empty).length;
  const lines: string[] = [];

  lines.push(`# ${inline(title)}`, "");
  lines.push(
    status === "empty"
      ? `_No recorded activity in this range. ${sections.length} period(s) covered, none with events._`
      : `_${sections.length} period(s) covered, ${populated} with recorded events. Facts as held by the evidence timeline._`,
    "",
  );
  lines.push(`- Events in range: ${timeline.includedEvents}`, "");

  for (const section of sections) {
    lines.push(...renderSection(section));
  }

  // Coverage notes appear only when something was left out. A document that
  // silently omits events outside the requested window, or events skipped as
  // malformed, is the same quiet-misleading artefact criterion 1 exists to
  // prevent — so when the timeline says anything was excluded, the document
  // says it too.
  const notes: string[] = [];
  if (timeline.excludedEvents > 0) {
    notes.push(
      `- ${timeline.excludedEvents} recorded event(s) fell outside every period above and are not shown.`,
    );
  }
  if (timeline.skippedEvents > 0) {
    const reasons = Object.entries(timeline.skippedByReason)
      .map(([reason, count]) => `${reason} (${count})`)
      .join(", ");
    notes.push(
      `- ${timeline.skippedEvents} event row(s) were skipped as unusable and are not shown${reasons === "" ? "" : `: ${reasons}`}.`,
    );
  }
  if (notes.length > 0) {
    lines.push("**Coverage notes**", "", ...notes, "");
  }

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const DEFAULT_TITLE = "Review summary";

/**
 * Render the review-ready period document for an evidence timeline.
 *
 * NEVER THROWS for any input this module accepts. The three states it can be in
 * are all normal: a full document (`status: "rendered"`), a document whose
 * requested periods were all empty (`status: "empty"`), and a rejected call
 * carrying a typed {@link ReviewSummaryErrorCode}. The only rejections are
 * caller bugs that would make the document ambiguous — an empty requested-period
 * list, a period without bounds, or two periods sharing a name.
 *
 * `options.periods` is what makes the difference between "there was nothing in
 * Q1" and "Q1 was never asked about"; see {@link ReviewSummaryOptions.periods}.
 */
export function buildReviewSummary(
  timeline: EvidenceTimeline,
  options: ReviewSummaryOptions = {},
): ReviewSummaryResult {
  const validatedPeriods = validateRequestedPeriods(options.periods);
  if (!validatedPeriods.ok) return validatedPeriods;

  const indexed = indexTimelinePeriods(timeline);
  if (!indexed.ok) return indexed;

  const sections = assembleSections(
    validatedPeriods.value,
    timeline,
    indexed.value,
  );
  const status: ReviewSummaryStatus =
    timeline.periods.length === 0 ? "empty" : "rendered";

  return {
    ok: true,
    value: {
      status,
      markdown: renderDocument(
        sections,
        timeline,
        options.title ?? DEFAULT_TITLE,
        status,
      ),
      sections,
      includedEvents: timeline.includedEvents,
    },
  };
}
