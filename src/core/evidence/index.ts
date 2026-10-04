/**
 * Public surface of the provider-neutral evidence timeline.
 *
 * Re-exports only: no logic lives here. `src/core/evidence/**` is a library
 * with a tested, caller-free surface — the composition root that wires it into
 * the app is a separate card.
 */

export {
  EVENT_REJECTION_REASONS,
  TIMELINE_ERROR_CODES,
  buildEvidenceTimeline,
  isIso8601DateTime,
  sortChronologically,
  validateTimelineEvent,
} from "./timeline";
export type {
  EventRejectionCounts,
  EventRejectionReason,
  EventSourceCounts,
  EventTypeCounts,
  EvidenceTimeline,
  PeriodSummary,
  TimelineError,
  TimelineErrorCode,
  TimelineEventValidation,
  TimelinePeriod,
  TimelineResult,
} from "./timeline";
