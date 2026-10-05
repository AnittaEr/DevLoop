/**
 * Public surface of the provider-neutral review-summary renderer.
 *
 * Re-exports only: no logic lives here. `src/core/review/**` is a library with
 * a tested, caller-free surface — the composition root that wires it into the
 * app is a separate card, and deliberately so: the wiring is exactly what
 * would smuggle a provider concept upward, so it must be reviewable apart from
 * the renderer.
 *
 * The types here come from `@/core/evidence` and are NOT re-declared. The
 * renderer reads the aggregation's own shapes, so a second declaration would be
 * a second thing to keep in step with the first.
 */

export {
  REVIEW_SUMMARY_ERROR_CODES,
  REVIEW_SUMMARY_STATUSES,
  buildReviewSummary,
} from "./render";
export type {
  ReviewSummaryDocument,
  ReviewSummaryError,
  ReviewSummaryErrorCode,
  ReviewSummaryOptions,
  ReviewSummaryResult,
  ReviewSummarySection,
  ReviewSummaryStatus,
} from "./render";
