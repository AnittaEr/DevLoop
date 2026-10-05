/**
 * `/review` — the review-ready period document, rendered (T24).
 *
 * THIS IS THE FIRST PAGE THAT CALLS `buildReviewSummary()`. At batch 15's
 * assembled head (`811ad07`) the renderer had three references and not one
 * non-test caller: a definition, a re-export, and a suite. Every gate in this
 * repository answers "is what we wrote correct?" and never "does anything use
 * it?", so an unused export is pristine under lint, typecheck, the boundary
 * guards, the orphan-test-file registry and the build. This page is the
 * deliverable that measurement was asking for.
 *
 * THE GUARD RUNS BEFORE THE READ, AND THAT ORDER IS THE WHOLE POINT. Every
 * statement below the `requireSession()` call is a statement that can touch
 * `canonical_events`. There is no code path that reaches the read with an
 * unauthenticated request, so no code path can put an event title, id,
 * timestamp, `source`, count or period summary into a response body for one —
 * including in a prefetch payload, which is why the refusal is asserted on the
 * rendered string by `__tests__/review-page.test.tsx` and not on a status code.
 *
 * IT CALLS B46'S SEAM AND NOTHING ELSE. `requireSession()` from
 * `src/lib/session-guard.ts`, which reads through T19's `getSession()`. No
 * cookie is read here, `getSession()` is not called directly, and
 * `auth.api.getSession` is not reachable from this file at all.
 *
 * THE MISCONFIGURATION IS RENDERED, NOT REDIRECTED (PM's D-285). When
 * `requireSession()` answers `auth_not_configured` — what `getSession()` throws
 * as a consequence when `BETTER_AUTH_SECRET` is missing or set to Better Auth's
 * published default — this page renders a loud, named configuration panel and
 * reads NOTHING. It does not redirect to `/sign-in`, because that would tell a
 * developer with a broken `.env` they are merely signed out and then park them
 * on a form that can never work; and it does not catch the error into a 401,
 * because "this server cannot tell who anyone is" is not "nobody is signed in".
 * Same handling as `/evidence`, deliberately: a misconfiguration must not look
 * different depending on which page the developer happened to open.
 *
 * IT READS THROUGH THE SAME SEAM `/evidence` USES. `readCanonicalEvents()` from
 * `@/app/evidence/read-canonical-events` and `buildEvidenceTimeline()` from
 * `@/core/evidence`. This page queries no table, re-aggregates nothing, and
 * re-counts no number it did not receive from the timeline. The renderer's own
 * criterion 2 — print the aggregation's figures rather than re-deriving them —
 * is only meaningful if the aggregation reaching it is the shipped one.
 *
 * PROVIDER NEUTRALITY (hard rule 1). `source` reaches this page as the opaque
 * string the database holds and is rendered verbatim, never matched against a
 * vendor and never given a label. Nothing here or in anything it imports
 * reaches `src/plugins/github/**`. The period labels are "Earlier"/"Later" —
 * calendar vocabulary, not a forge's.
 */

import { redirect } from "next/navigation";

import { GuardNotice } from "@/app/auth/guard-notice";
import { SignOutButton } from "@/app/auth/sign-out-button";
import { SIGNED_OUT_DESTINATION } from "@/app/evidence/destination";
import {
  READ_OUTCOMES,
  readCanonicalEvents,
} from "@/app/evidence/read-canonical-events";
import { ReviewSummaryPanel } from "@/app/review/summary-panel";
import { buildEvidenceTimeline } from "@/core/evidence";
import type { CanonicalEvent } from "@/core/events/canonical-event";
import { SESSION_GUARD_OUTCOMES, requireSession } from "@/lib/session-guard";

/**
 * Forced dynamic, for the same reason `/evidence` and the sync route set it: the
 * entire output depends on live cookie state and live database state, and a
 * cached response would be a cached copy of one developer's review served to
 * whoever asked next.
 */
export const dynamic = "force-dynamic";

/**
 * The periods the document covers.
 *
 * DERIVED FROM THE DATA, NEVER FROM A CLOCK. `buildEvidenceTimeline` refuses an
 * empty period list, so something has to choose them — and a helper that called
 * `new Date()` to pick "this quarter" would make the document's contents depend
 * on when it was rendered, so a review reprinted next month would not match the
 * one pasted this month. Instead the window is the full observed span of the
 * events themselves, split at the median instant, which is deterministic for a
 * given set of rows and needs no clock at all.
 *
 * THE EMPTY CASE IS HANDLED HERE, BEFORE ANY ARITHMETIC. With zero events
 * `sorted[0]` is `undefined` and `new Date(undefined)` throws
 * `RangeError: Invalid time value`, so a brand-new installation would render a
 * crash instead of "nothing recorded yet". Returning no periods is the honest
 * answer, and it is handled by the caller as an explicit empty state rather than
 * routed into a helper that would reject it.
 *
 * `+3` ms on the upper bound so the newest event falls INSIDE the last period:
 * `buildEvidenceTimeline`'s upper bound is exclusive, so a bound of exactly
 * `latest` would drop the most recent event and silently under-report the count.
 *
 * FRICTION WORTH RECORDING. This rule is derived twice — `/evidence` derives the
 * same window from the same rows. It lives inline in that page and is not
 * exported, and this card's DO NOT TOUCH forbids refactoring that page to share
 * it, so the derivation is restated here rather than composed. Two copies of a
 * period rule can disagree, and a disagreement would show up as two pages
 * summarising the same rows differently. A shared, exported `periodsFor()` under
 * `src/app/evidence/**` is the obvious follow-up; it is deliberately NOT done
 * here because it would edit T20's approved page.
 */
function periodsFor(events: readonly CanonicalEvent[]): {
  name: string;
  from: string;
  to: string;
}[] {
  const sorted = [...events]
    .map((event) => Date.parse(event.occurredAt))
    .sort((left, right) => left - right);

  const earliest = sorted[0];
  const latest = sorted[sorted.length - 1];
  if (earliest === undefined || latest === undefined) return [];

  // One event, or several sharing one instant: a midpoint window would be
  // inverted (from >= to) and the helper rejects that, so a single full-span
  // period is used instead.
  if (earliest === latest) {
    return [
      {
        name: "All recorded evidence",
        from: new Date(earliest).toISOString(),
        to: new Date(latest + 3).toISOString(),
      },
    ];
  }

  const midpoint = sorted[Math.floor(sorted.length / 2)] as number;
  return [
    {
      name: "Earlier",
      from: new Date(earliest - 1).toISOString(),
      to: new Date(midpoint).toISOString(),
    },
    {
      name: "Later",
      from: new Date(midpoint - 1).toISOString(),
      to: new Date(latest + 3).toISOString(),
    },
  ];
}

export default async function ReviewPage() {
  // ── THE GUARD. Nothing below runs unless this says `ok`. ────────────────────
  const guard = await requireSession();

  if (guard.ok === false) {
    if (guard.outcome === SESSION_GUARD_OUTCOMES.authNotConfigured) {
      // Read NOTHING, redirect NOWHERE. A named configuration fault, rendered.
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
          <GuardNotice
            refusal={guard.body}
            title="Review is not available: auth is not configured"
          />
        </main>
      );
    }

    if (guard.outcome === SESSION_GUARD_OUTCOMES.sessionRequired) {
      // `redirect()` throws a control-flow signal Next.js turns into a 307 with
      // an empty body, so the response carries the Location header and not one
      // byte of evidence. The event list is never even read, so there is nothing
      // to leak in a prefetch, a cache, or an error boundary.
      redirect(SIGNED_OUT_DESTINATION);
    }

    // Unreachable: `SessionGuardResult` has exactly three members and both
    // refusals are handled above. A fourth outcome would throw rather than fall
    // through and render a document without a guard — the safe direction.
    throw new Error(
      "Unreachable: requireSession() returned an outcome this page does not handle.",
    );
  }

  // ── AUTHENTICATED. From here the read is allowed. ───────────────────────────
  const read = await readCanonicalEvents();

  if (read.ok === false) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
        <h1 className="text-3xl font-bold tracking-tight">Review</h1>
        <section
          role="alert"
          data-testid="database-notice"
          data-outcome={read.outcome}
          className="flex flex-col gap-2 rounded-lg border border-red-500 bg-red-50 p-6 text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          <h2 className="text-lg font-semibold">
            The evidence database is unavailable
          </h2>
          <p className="text-sm">{read.message}</p>
          <p className="text-xs">
            Condition: <code>{READ_OUTCOMES.databaseUnavailable}</code>
          </p>
        </section>
      </main>
    );
  }

  const periods = periodsFor(read.events);

  // Handled BEFORE the helper, because `buildEvidenceTimeline` REFUSES an empty
  // period list with `no_periods` — it treats a bad period list as a caller bug,
  // and a zero-row table is not one. "Nothing to summarise" is a normal answer
  // here, so it is rendered directly rather than routed through a call that
  // would reject it.
  if (periods.length === 0) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-3xl font-bold tracking-tight">Review</h1>
          <SignOutButton />
        </div>
        <p data-testid="review-empty">
          No evidence has been recorded yet, so there is nothing to summarise.
        </p>
      </main>
    );
  }

  const timeline = buildEvidenceTimeline(read.events, periods);

  if (timeline.ok === false) {
    // The periods are derived from the events, so this is unreachable with the
    // helper shipped as is — it is handled rather than ignored so a future
    // change to the period rule surfaces as a named refusal and not as an empty
    // document that reads like "no activity".
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
        <section role="alert" data-testid="timeline-notice">
          <h2 className="text-lg font-semibold">
            The review period could not be built
          </h2>
          <p className="text-sm">
            Condition: <code>{timeline.error.code}</code> —{" "}
            {timeline.error.message}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">Review</h1>
        <SignOutButton />
      </div>
      <ReviewSummaryPanel timeline={timeline.value} periods={periods} />
    </main>
  );
}
