/**
 * The one place `buildReviewSummary()`'s RESULT becomes markup (T24).
 *
 * WHY THIS IS A SEPARATE MODULE AND NOT INLINE IN THE PAGE. The page's own
 * inputs can never make the renderer reject: the periods it derives from the
 * events are non-empty, well-shaped and distinctly named, so a rejection branch
 * written inline in `page.tsx` would be unreachable in production AND
 * untestable — a branch with no test is a branch that is wrong in a way nobody
 * finds. Taking the timeline and the requested periods as parameters puts the
 * renderer's typed rejection on a seam a test can drive with the very inputs
 * that trigger it, so `REVIEW_SUMMARY_ERROR_CODES` are rendered by code that
 * demonstrably runs.
 *
 * THE RENDERER DECIDES; THIS MODULE ONLY PRINTS. Every number shown here is
 * read off `ReviewSummaryDocument` / `ReviewSummarySection` — the markdown,
 * the tallies, the included count — and none is recomputed, re-derived or
 * re-counted. If the document and a section ever disagreed, that disagreement
 * is displayed rather than smoothed over, which is the renderer's own
 * criterion 2 and the reason it exists as a separate reviewed module.
 *
 * THE MARKDOWN IS SHOWN AS TEXT, NOT PARSED. There is no markdown renderer in
 * this project's dependency set and adding one is not this card's call, so the
 * paste-ready document is emitted verbatim inside a `<pre>` where every
 * character survives a copy-paste into a review. The structured `sections` are
 * rendered alongside it as real markup, which is what a reader scans; the
 * `<pre>` is what a developer pastes. Printing the same document twice from one
 * source is not a second rendering pipeline — it is the renderer's output and
 * the renderer's sections, both straight through.
 *
 * PROVIDER NEUTRALITY (hard rule 1). Every `source` below is the opaque string
 * the database holds, printed as the key it is. It is never compared against a
 * vendor, never translated, never labelled, and no field name here is shaped
 * after any one of them.
 */

import type { EvidenceTimeline, TimelinePeriod } from "@/core/evidence";
import { buildReviewSummary } from "@/core/review";

/** The review document's heading, fixed rather than chosen per request. */
const TITLE = "Review summary";

/**
 * One tally line per key. Keys are printed exactly as the aggregation holds
 * them, which is why the map is rendered generically rather than iterated over
 * a known set: a known set would be a provider vocabulary.
 */
function Tally({
  label,
  entries,
}: {
  readonly label: string;
  readonly entries: Readonly<Record<string, number>>;
}) {
  const rows = Object.entries(entries);
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold">{label}</h4>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None recorded.</p>
      ) : (
        <ul className="text-sm">
          {rows.map(([key, count]) => (
            <li key={key} data-testid={`tally-${label}-${key}`}>
              {/* The key is the opaque discriminator, verbatim. */}
              {key}: {count}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Render the document, or the renderer's refusal when it rejects the call.
 *
 * The rejection branch is the point of this module's existence: it names the
 * typed code, the offending period's name when there is one, and the
 * explanation, so a caller that got its period list wrong learns which way
 * rather than receiving an empty page that reads like "no activity".
 */
export function ReviewSummaryPanel({
  timeline,
  periods,
}: {
  readonly timeline: EvidenceTimeline;
  readonly periods: readonly TimelinePeriod[];
}) {
  const result = buildReviewSummary(timeline, { periods, title: TITLE });

  if (result.ok === false) {
    return (
      <section
        role="alert"
        data-testid="review-rejected"
        data-error-code={result.error.code}
        className="flex flex-col gap-2 rounded-lg border border-red-500 bg-red-50 p-6 text-red-900 dark:bg-red-950 dark:text-red-100"
      >
        <h2 className="text-lg font-semibold">
          The review summary could not be built
        </h2>
        <p className="text-sm">{result.error.message}</p>
        <p className="text-xs">
          Condition: <code>{result.error.code}</code>
          {result.error.periodName === null ? null : (
            <>
              {" "}
              — period: <code>{result.error.periodName}</code>
            </>
          )}
        </p>
      </section>
    );
  }

  const document_ = result.value;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground" data-testid="review-status">
        {document_.status === "empty"
          ? `No recorded activity in this range. ${document_.sections.length} period(s) covered, none with events.`
          : `${document_.sections.length} period(s) covered, ${
              document_.sections.filter((section) => !section.empty).length
            } with recorded events.`}{" "}
        {/* `includedEvents` is the aggregation's own figure, copied. */}
        <span data-testid="review-included-events">
          Events in range: {document_.includedEvents}
        </span>
      </p>

      {document_.sections.map((section) => (
        <section
          key={section.name}
          data-testid={`review-period-${section.name}`}
        >
          <h3 className="text-xl font-semibold">
            {section.name} ({section.total})
          </h3>
          <p className="text-xs text-muted-foreground">
            {section.from} (inclusive) to {section.to} (exclusive)
          </p>

          {section.empty ? (
            <p className="text-sm">No events were recorded in this period.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <Tally label="By type" entries={section.byType} />
              <Tally label="By source" entries={section.bySource} />
              <ul className="flex flex-col text-sm">
                {section.events.map((event) => (
                  <li
                    key={event.id}
                    className="border-input border-b py-1 last:border-b-0"
                  >
                    {event.occurredAt} — {event.type} — {event.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ))}

      {/* The paste-ready document, verbatim and unparsed. */}
      <section data-testid="review-markdown">
        <h3 className="text-xl font-semibold">Paste-ready document</h3>
        <pre className="border-input overflow-x-auto whitespace-pre-wrap rounded-lg border p-4 text-xs">
          {document_.markdown}
        </pre>
      </section>
    </div>
  );
}
