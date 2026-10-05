/**
 * `/evidence` — the FIRST genuinely evidence-protected page (T20).
 *
 * THIS IS THE PAGE B46 COULD NOT HAVE. B46's original c6 required every page
 * rendering persisted canonical events to redirect an unauthenticated visitor,
 * while its own OUT OF SCOPE forbade building a sign-in UI — so the only two
 * available resolutions were a redirect to a URL that did not exist (locking the
 * single local user out entirely, in service of a security guard) or silently
 * skipping the criterion. Neither happened: PM proved the surface was ZERO and
 * removed the clause. This card is what actually satisfies it.
 *
 * THE GUARD RUNS BEFORE THE READ, AND THAT ORDER IS THE WHOLE POINT. Every
 * statement below the `requireSession()` call is a statement that can touch
 * `canonical_events`. There is no code path that reaches the read with an
 * unauthenticated request, so no code path can put an event title, id, timestamp
 * or `source` into a response body for one. That is asserted on the RENDERED
 * OUTPUT by `__tests__/evidence-page.test.tsx`, not on a status code — a
 * redirect that leaked content in a prefetch body would pass a status check
 * while shipping exactly the data this page exists to withhold.
 *
 * IT CALLS B46'S SEAM AND NOTHING ELSE. `requireSession()` from
 * `src/lib/session-guard.ts`, which reads through T19's `getSession()`. No
 * cookie is read here, `getSession()` is not called directly, and
 * `auth.api.getSession` is not reachable from this file at all. A second
 * cookie-reading path is the specific defect that makes a server-side check
 * report "signed out" for a signed-in user, and c3 exists to stop it.
 *
 * THE MISCONFIGURATION IS RENDERED, NOT REDIRECTED (PM's D-285). When
 * `requireSession()` answers `auth_not_configured` — which is what
 * `getSession()` throws's consequence when `BETTER_AUTH_SECRET` is missing or
 * Better Auth's published default — this page renders a loud, named
 * configuration panel and reads NOTHING. It does not redirect to `/sign-in`,
 * because a redirect would tell a developer with a broken `.env` that they are
 * merely signed out, and they would then sit on a sign-in form that can never
 * work. It does not render the signed-out state either, and it does not catch
 * the error into a 401. Treating "this server cannot tell who anyone is" as
 * "nobody is signed in" is the exact silent-default failure D2 and D5 were
 * raised to kill.
 *
 * PROVIDER NEUTRALITY (hard rule 1, c8). `source` is rendered as the opaque
 * string the database holds. It is never matched against a vendor, never
 * translated, never given a label, and no column or field name here is
 * provider-shaped. Nothing in this file or its imports reaches
 * `src/plugins/github/**`.
 */

import { redirect } from "next/navigation";

import { GuardNotice } from "@/app/auth/guard-notice";
import { SignOutButton } from "@/app/auth/sign-out-button";
import {
  READ_OUTCOMES,
  readCanonicalEvents,
} from "@/app/evidence/read-canonical-events";
import { SIGNED_OUT_DESTINATION } from "@/app/evidence/destination";
import { buildEvidenceTimeline } from "@/core/evidence/timeline";
import type { CanonicalEvent } from "@/core/events/canonical-event";
import { SESSION_GUARD_OUTCOMES, requireSession } from "@/lib/session-guard";

/**
 * Forced dynamic, for the same reason the sync route sets it: the entire output
 * depends on live cookie state and live database state, and a cached response
 * would be a cached copy of one user's evidence served to whoever asked next.
 */
export const dynamic = "force-dynamic";

/**
 * The periods handed to the pure timeline helper.
 *
 * DERIVED FROM THE DATA, NEVER FROM A CLOCK. `buildEvidenceTimeline` takes
 * caller-supplied periods and refuses an empty list, so something has to choose
 * them — and a helper that called `new Date()` to pick "this quarter" would make
 * the page's output depend on when it was rendered. Instead the window is the
 * full observed span of the events themselves, split at the median instant into
 * two halves, which is deterministic for a given set of rows and needs no clock
 * at all.
 *
 * THE EMPTY CASE IS HANDLED HERE, BEFORE ANY ARITHMETIC. Measured: with zero
 * events `sorted` is empty, `sorted[0]` is `undefined`, and `new Date(undefined)`
 * throws `RangeError: Invalid time value` — so a brand-new installation with an
 * empty `canonical_events` table would have rendered a crash instead of "No
 * evidence has been recorded yet". Returning no periods is the honest answer,
 * and `buildEvidenceTimeline` reports an empty timeline for it, which the page
 * renders as the explicit empty state.
 *
 * `+3` ms on the upper bound so the newest event is INSIDE the last period:
 * `buildEvidenceTimeline`'s upper bound is exclusive, so a bound of exactly
 * `latest` would drop the most recent event and silently under-report the count.
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
        name: "All evidence",
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

/** One rendered row. Fields are the domain type's, never a provider's. */
function EventRow({ event }: { readonly event: CanonicalEvent }) {
  return (
    <li className="border-input flex flex-col gap-1 border-b py-2 last:border-b-0">
      <span className="font-medium">{event.title}</span>
      <span className="text-xs text-muted-foreground">
        {event.occurredAt} · {event.type} · source: {event.source}
      </span>
    </li>
  );
}

export default async function EvidencePage() {
  // ── THE GUARD. Nothing below runs unless this says `ok`. ────────────────────
  const guard = await requireSession();

  if (guard.ok === false) {
    if (guard.outcome === SESSION_GUARD_OUTCOMES.authNotConfigured) {
      // Read NOTHING, redirect NOWHERE. A named configuration fault, rendered.
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
          <GuardNotice
            refusal={guard.body}
            title="Evidence is not available: auth is not configured"
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
    // refusals are handled above. If a fourth outcome is ever added, this throws
    // rather than falling through to render evidence without a guard — the safe
    // direction.
    throw new Error(
      "Unreachable: requireSession() returned an outcome this page does not handle.",
    );
  }

  // ── AUTHENTICATED. From here the read is allowed. ───────────────────────────
  const read = await readCanonicalEvents();

  if (read.ok === false) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
        <h1 className="text-3xl font-bold tracking-tight">Evidence</h1>
        <section
          role="alert"
          data-testid="database-notice"
          data-outcome={read.outcome}
          className="flex flex-col gap-2 rounded-lg border border-red-500 bg-red-50 p-6 text-red-900"
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
  // period list with `no_periods` — it treats a bad period list as a caller bug
  // and a zero-row table is not one. "Nothing to summarise" is a normal answer
  // here, so the empty state is rendered directly rather than routed through a
  // call that would reject it.
  if (periods.length === 0) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-3xl font-bold tracking-tight">Evidence</h1>
          <SignOutButton />
        </div>
        <p data-testid="evidence-empty">No evidence has been recorded yet.</p>
      </main>
    );
  }

  const timeline = buildEvidenceTimeline(read.events, periods);

  if (timeline.ok === false) {
    // The periods are derived from the events, so this is unreachable with the
    // helper shipped as is — it is handled rather than ignored so a future
    // change to the period rule surfaces as a named refusal and not as an
    // empty page that looks like "no evidence yet".
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
        <section role="alert" data-testid="timeline-notice">
          <h2 className="text-lg font-semibold">
            The evidence period could not be built
          </h2>
          <p className="text-sm">
            Condition: <code>{timeline.error.code}</code> —{" "}
            {timeline.error.message}
          </p>
        </section>
      </main>
    );
  }

  const value = timeline.value;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">Evidence</h1>
        <SignOutButton />
      </div>

      <p
        className="text-sm text-muted-foreground"
        data-testid="evidence-summary"
      >
        {value.includedEvents} event{value.includedEvents === 1 ? "" : "s"}{" "}
        across {value.periods.length} period
        {value.periods.length === 1 ? "" : "s"}
        {value.excludedEvents > 0
          ? `, ${value.excludedEvents} outside the requested periods`
          : ""}
        {value.skippedEvents > 0
          ? `, ${value.skippedEvents} skipped as malformed`
          : ""}
        .
      </p>

      {value.periods.length === 0 ? (
        <p data-testid="evidence-empty">No evidence has been recorded yet.</p>
      ) : (
        value.periods.map((period) => (
          <section key={period.name} data-testid={`period-${period.name}`}>
            <h2 className="text-xl font-semibold">
              {period.name} ({period.total})
            </h2>
            <ul className="mt-2 flex flex-col">
              {period.events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
