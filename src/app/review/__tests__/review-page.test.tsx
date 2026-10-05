/**
 * Tests for the protected `/review` page and its summary panel (T24).
 *
 * THE ASSERTION IS ON THE RENDERED OUTPUT, NEVER ON A STATUS CODE — c6. Every
 * refusal test renders the component and asserts the canary event's TITLE, id,
 * timestamp and `source` are absent from the markup, not that a 3xx came back.
 * A redirect that leaked the document in a prefetch payload would pass a status
 * check while shipping exactly the data this page exists to withhold.
 *
 * THE READ IS COUNTED, NOT JUST MOCKED. A page that renders no document while
 * also having read every row would be "safe" for the wrong reason, and a future
 * edit that moved the read above the guard would still show green — so
 * `readCanonicalEvents` is a spy and the refusal tests assert it was NOT called.
 *
 * THE NEGATIVE CONTROL IS NOT OPTIONAL. The "renders the summary when signed in"
 * test below is what makes the signed-out tests meaningful: without it, a page
 * that rendered nothing at all under any guard outcome would pass every refusal
 * assertion. It is stated as a sibling test on the SAME page, same fixture.
 *
 * THE REJECTION BRANCH IS TESTED DIRECTLY, not through the page, because the
 * page's own period derivation cannot make `buildReviewSummary` reject — a
 * branch reachable only from a page is a branch no test can drive. The panel
 * takes the timeline and periods as parameters precisely so the typed
 * `REVIEW_SUMMARY_ERROR_CODES` have a seam here.
 *
 * PROVIDER NEUTRALITY IS STRUCTURAL. The last describe block reads the page and
 * panel sources off disk and scans the CODE (comments stripped) for vendor
 * vocabulary, which is why a header that names a vendor in prose does not fail
 * the scan.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvidenceTimeline } from "@/core/evidence";
import type { CanonicalEvent } from "@/core/events/canonical-event";
import { REVIEW_SUMMARY_ERROR_CODES } from "@/core/review";

/** From `src/app/review/__tests__` — four levels up reaches the parent of `src`. */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** A title that exists nowhere but this file and the fixture. */
const CANARY_TITLE = "canary-shipped-only-after-a-session";

const CANARY_SOURCE = "local-demo-source";

const CANARY_EVENT: CanonicalEvent = {
  id: "evt_review_canary_0001",
  source: CANARY_SOURCE,
  externalId: "canary-1",
  type: "release",
  title: CANARY_TITLE,
  occurredAt: "2026-01-15T10:00:00.000Z",
  metadata: {},
};

/** A second event, so the window splits into two periods rather than one. */
const LATER_EVENT: CanonicalEvent = {
  id: "evt_review_canary_0002",
  source: CANARY_SOURCE,
  externalId: "canary-2",
  type: "issue",
  title: "canary-second-period-only",
  occurredAt: "2026-03-20T08:30:00.000Z",
  metadata: {},
};

/**
 * `release` and `issue` are both members of `CANONICAL_EVENT_TYPES`; a fixture
 * naming a type that does not exist would be a compile error rather than a
 * silently-skipped event. `source` is a bare opaque string on purpose.
 */
const authenticatedSession = {
  session: {
    id: "session-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    token: "not-a-real-token",
    userId: "user-1",
  },
  user: {
    id: "user-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    emailVerified: false,
    name: "Local User",
    email: "local@example.invalid",
  },
};

const NO_SESSION_REFUSAL = {
  ok: false as const,
  outcome: "session_required" as const,
  status: 401 as const,
  body: {
    ok: false as const,
    outcome: "session_required" as const,
    message: "No valid session. Sign in first.",
    fetched: 0 as const,
    persisted: 0 as const,
  },
};

const UNCONFIGURED_REFUSAL = {
  ok: false as const,
  outcome: "auth_not_configured" as const,
  status: 503 as const,
  body: {
    ok: false as const,
    outcome: "auth_not_configured" as const,
    message:
      "BETTER_AUTH_SECRET is not set. Auth cookies cannot be signed without it.",
    fetched: 0 as const,
    persisted: 0 as const,
  },
};

const AUTHENTICATED = {
  ok: true as const,
  outcome: "authenticated" as const,
  session: authenticatedSession,
};

vi.mock("@/lib/session-guard", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireSession: vi.fn(),
}));

vi.mock("@/app/evidence/read-canonical-events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readCanonicalEvents: vi.fn(),
}));

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (destination: string) => redirect(destination),
}));

const { requireSession } = await import("@/lib/session-guard");
const { readCanonicalEvents } = await import(
  "@/app/evidence/read-canonical-events"
);
const { default: ReviewPage } = await import("../page");
const { ReviewSummaryPanel } = await import("../summary-panel");

const mockedRequireSession = vi.mocked(requireSession);
const mockedRead = vi.mocked(readCanonicalEvents);

beforeEach(() => {
  mockedRead.mockResolvedValue({
    ok: true,
    outcome: "ok",
    events: [CANARY_EVENT, LATER_EVENT],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Render the page and return its markup, turning the `redirect()` control-flow
 * throw into an empty string.
 *
 * `redirect()` in Next.js throws on purpose: it is a signal, not a return. A
 * test that treated it as a return value would assert on nothing, so the throw
 * is caught here and recorded via the `redirect` spy instead.
 */
async function render(): Promise<string> {
  try {
    return await renderToStaticMarkup(await ReviewPage());
  } catch (error) {
    if (redirect.mock.calls.length > 0) return "";
    throw error;
  }
}

describe("review page — signed out (c6)", () => {
  it("renders no event title, id, timestamp, source, count or summary", async () => {
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    const html = await render();

    expect(html).not.toContain(CANARY_TITLE);
    expect(html).not.toContain(CANARY_EVENT.id);
    expect(html).not.toContain(CANARY_EVENT.occurredAt);
    expect(html).not.toContain(CANARY_SOURCE);
    expect(html).not.toContain("Events in range");
    expect(html).not.toContain("Review summary");
    expect(html).not.toContain("review-period-");
    // Not even an empty shell a prefetch could hydrate from.
    expect(html).toBe("");
  });

  it("redirects a signed-out visitor to the sign-in page", async () => {
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    await render();

    expect(redirect).toHaveBeenCalledWith("/sign-in");
  });

  it("never reads the database for a signed-out visitor", async () => {
    // The guard being load-bearing means the read is UNREACHABLE, not merely
    // unused. Without this, an edit that moved the read above the guard would
    // still render no title while reading every row in the table.
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    await render();

    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("renders no event content even if the reader would return rows", async () => {
    // The trap this asserts: a reader primed with real rows must not change the
    // signed-out output. If the read were reached, the canary would appear.
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);
    mockedRead.mockResolvedValue({
      ok: true,
      outcome: "ok",
      events: [CANARY_EVENT],
    });

    const html = await render();

    expect(html).not.toContain(CANARY_TITLE);
  });
});

describe("review page — auth not configured (c7)", () => {
  it("names the CONFIGURATION fault and never the missing session", async () => {
    mockedRequireSession.mockResolvedValue(UNCONFIGURED_REFUSAL);

    const html = await render();

    expect(html).toContain("auth is not configured");
    expect(html).toContain("BETTER_AUTH_SECRET");
    expect(html).toContain("auth_not_configured");
    expect(html).not.toContain("NO SESSION");
  });

  it("does NOT redirect to sign-in on a misconfiguration", async () => {
    // Redirecting here would drop the developer on a sign-in form that can
    // never work, which is the silent-default failure this card exists to stop.
    mockedRequireSession.mockResolvedValue(UNCONFIGURED_REFUSAL);

    await render();

    expect(redirect).not.toHaveBeenCalled();
  });

  it("renders no event content and reads nothing when auth is unconfigured", async () => {
    mockedRequireSession.mockResolvedValue(UNCONFIGURED_REFUSAL);

    const html = await render();

    expect(html).not.toContain(CANARY_TITLE);
    expect(mockedRead).not.toHaveBeenCalled();
  });
});

/**
 * THE NEGATIVE CONTROL (c6). Every assertion above would pass against a page
 * that rendered nothing under any guard outcome. This is the sibling test that
 * proves it does render — same page, same fixture, one variable changed.
 */
describe("review page — authenticated (negative control)", () => {
  it("DOES render the summary, the canary and the opaque source when signed in", async () => {
    mockedRequireSession.mockResolvedValue(AUTHENTICATED);

    const html = await render();

    expect(html).toContain(CANARY_TITLE);
    expect(html).toContain(LATER_EVENT.title);
    expect(html).toContain(CANARY_EVENT.occurredAt);
    // `source` verbatim, as the opaque string the database holds.
    expect(html).toContain(CANARY_SOURCE);
    expect(html).toContain("Events in range");
    expect(html).toContain("review-period-");
    // Both requested periods appear, including the one holding the later event.
    expect(html).toContain("Earlier");
    expect(html).toContain("Later");
  });

  it("emits the renderer's paste-ready markdown on the page", async () => {
    mockedRequireSession.mockResolvedValue(AUTHENTICATED);

    const html = await render();

    // The markdown is the deliverable: it is what gets pasted into a review.
    expect(html).toContain("Paste-ready document");
    expect(html).toContain("Review summary");
  });

  it("does not redirect a signed-in visitor", async () => {
    mockedRequireSession.mockResolvedValue(AUTHENTICATED);

    await render();

    expect(redirect).not.toHaveBeenCalled();
  });

  it("renders an explicit empty state rather than nothing when there are no events", async () => {
    // "No evidence yet" and "the guard silently swallowed the read" must not look
    // the same, or the page's own emptiness becomes untestable.
    mockedRequireSession.mockResolvedValue(AUTHENTICATED);
    mockedRead.mockResolvedValue({ ok: true, outcome: "ok", events: [] });

    const html = await render();

    expect(html).toContain("No evidence has been recorded yet");
    expect(html).not.toContain(CANARY_TITLE);
  });

  it("renders a named refusal when the database is unreachable", async () => {
    mockedRequireSession.mockResolvedValue(AUTHENTICATED);
    mockedRead.mockResolvedValue({
      ok: false,
      outcome: "database_unavailable",
      message: "The evidence database is not reachable.",
      fetched: 0,
    });

    const html = await render();

    expect(html).toContain("database_unavailable");
    expect(html).not.toContain(CANARY_TITLE);
  });

  it("collapses a single instant into one full-span period without crashing", async () => {
    // The degenerate window: with one event, earliest === latest, and a midpoint
    // split would be inverted (from >= to) and rejected by the helper. Measured
    // here because `new Date(undefined)` on an empty table throws a RangeError,
    // and a thrown page is not an empty state.
    mockedRequireSession.mockResolvedValue(AUTHENTICATED);
    mockedRead.mockResolvedValue({
      ok: true,
      outcome: "ok",
      events: [CANARY_EVENT],
    });

    const html = await render();

    expect(html).toContain("All recorded evidence");
    expect(html).toContain(CANARY_TITLE);
  });
});

/* -------------------------------------------------------------------------- */
/* The renderer's typed rejections (c8)                                       */
/* -------------------------------------------------------------------------- */

describe("review panel — the renderer's typed rejections are surfaced (c8)", () => {
  /**
   * A timeline built by hand rather than by the page, so the panel's rejection
   * branch is reachable with inputs that actually trigger it. `includedEvents`
   * is deliberately 7 while `periods` holds one entry with a single event: the
   * panel prints both figures rather than reconciling them, which is the
   * renderer's criterion 2 and the property c3 depends on.
   */
  const handBuiltTimeline = {
    periods: [
      {
        name: "Earlier",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
        total: 1,
        byType: { release: 1 },
        bySource: { [CANARY_SOURCE]: 1 },
        events: [CANARY_EVENT],
      },
    ],
    includedEvents: 7,
    excludedEvents: 0,
    skippedEvents: 0,
    skippedByReason: {},
  } as unknown as EvidenceTimeline;

  const EARLIER_PERIOD = {
    name: "Earlier",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-02-01T00:00:00.000Z",
  };

  it("renders the document and copies the aggregation's own figures (no re-count)", () => {
    const html = renderToStaticMarkup(
      <ReviewSummaryPanel
        timeline={handBuiltTimeline}
        periods={[EARLIER_PERIOD]}
      />,
    );

    // 7 is the timeline's figure and 1 is the period's; a re-counting panel would
    // have printed one or the other, never both.
    expect(html).toContain("Events in range: 7");
    expect(html).toContain("Earlier (1)");
    expect(html).not.toContain("review-rejected");
  });

  it("surfaces no_requested_periods when the requested period list is empty", () => {
    const html = renderToStaticMarkup(
      <ReviewSummaryPanel timeline={handBuiltTimeline} periods={[]} />,
    );

    expect(html).toContain("review-rejected");
    expect(html).toContain("no_requested_periods");
  });

  it("surfaces duplicate_requested_period_name and names the offending period", () => {
    const html = renderToStaticMarkup(
      <ReviewSummaryPanel
        timeline={handBuiltTimeline}
        periods={[
          EARLIER_PERIOD,
          {
            name: "Earlier",
            from: "2026-02-01T00:00:00.000Z",
            to: "2026-03-01T00:00:00.000Z",
          },
        ]}
      />,
    );

    expect(html).toContain("duplicate_requested_period_name");
    // A rejection must render no document.
    expect(html).not.toContain("Events in range");
  });

  it("surfaces malformed_requested_period for a period with no bounds", () => {
    const html = renderToStaticMarkup(
      <ReviewSummaryPanel
        timeline={handBuiltTimeline}
        // A blank bound is not a `TimelinePeriod`; the cast is deliberate and the
        // renderer is required to reject it rather than print an empty range.
        periods={
          [
            { name: "Earlier", from: "", to: "" },
          ] as unknown as (typeof EARLIER_PERIOD)[]
        }
      />,
    );

    expect(html).toContain("malformed_requested_period");
  });

  it("surfaces duplicate_timeline_period_name from a hand-assembled timeline", () => {
    const duplicated = {
      ...handBuiltTimeline,
      periods: [handBuiltTimeline.periods[0], handBuiltTimeline.periods[0]],
    } as unknown as EvidenceTimeline;

    const html = renderToStaticMarkup(
      <ReviewSummaryPanel timeline={duplicated} periods={[EARLIER_PERIOD]} />,
    );

    expect(html).toContain("duplicate_timeline_period_name");
  });

  it("names every code the renderer declares, so none is silently unrendered", () => {
    // The panel renders whatever code the renderer returns, so the declared list
    // is exactly the list this page can surface. Asserted as a set equality so a
    // code added to the renderer later is noticed here rather than in production.
    expect([...REVIEW_SUMMARY_ERROR_CODES].sort()).toEqual([
      "duplicate_requested_period_name",
      "duplicate_timeline_period_name",
      "malformed_requested_period",
      "no_requested_periods",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Structural guarantees                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Strip comments from a source, leaving code only.
 *
 * NECESSARY, AND MEASURED: both files' headers name the very things the scan
 * below forbids (they say `auth.api.getSession` is unreachable, and the
 * neutrality rule names a vendor), so a raw `not.toContain` fails on prose
 * describing code. The walk tracks string, template and comment state so a `//`
 * inside a string does not truncate the line the way
 * `source.replace(/\/\/.*$/gm, "")` would — and truncating a line is how a real
 * call would be hidden from the scan.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: '"' | "'" | "`" | null = null;
  while (i < source.length) {
    const char = source[i] ?? "";
    if (quote) {
      out += char;
      if (char === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += "\n";
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

describe("review page — structural guarantees (c3, c4, c5)", () => {
  const pageSource = readFileSync(
    path.join(REPO_ROOT, "src/app/review/page.tsx"),
    "utf8",
  );
  const panelSource = readFileSync(
    path.join(REPO_ROOT, "src/app/review/summary-panel.tsx"),
    "utf8",
  );
  /** Code only: both headers name the forbidden tokens in prose. */
  const pageCode = stripComments(pageSource);
  const panelCode = stripComments(panelSource);

  it("calls B46's seam rather than reading a cookie itself", () => {
    // Structural, because that is the property: a mock cannot prove which module
    // the page reaches the session through.
    expect(pageSource).toContain('from "@/lib/session-guard"');
    expect(pageCode).toContain("requireSession()");
    expect(pageCode).not.toContain("auth.api.getSession");
    expect(pageCode).not.toContain("getSession(");
    expect(pageCode).not.toContain("cookies()");
    expect(pageCode).not.toContain("cookieStore");
  });

  it("reads through the same seam as /evidence and builds via @/core/evidence", () => {
    // c3: one reader, one aggregation. A second reader or a hand-rolled count
    // would make the two pages disagree about the same rows.
    expect(pageSource).toContain('from "@/app/evidence/read-canonical-events"');
    expect(pageCode).toContain("readCanonicalEvents()");
    expect(pageSource).toContain('from "@/core/evidence"');
    expect(pageCode).toContain("buildEvidenceTimeline(");
    // No direct database reach from the page or the panel.
    for (const code of [pageCode, panelCode]) {
      expect(code).not.toContain("db/schema");
      expect(code).not.toContain("getDb(");
      expect(code).not.toContain("canonicalEvents");
    }
  });

  it("reaches no plugin implementation and names no provider", () => {
    for (const code of [pageCode, panelCode]) {
      expect(code).not.toContain("@/plugins/");
      expect(code).not.toContain("src/plugins/");
      expect(code).not.toContain("process.env.");
      expect(code).not.toContain("console.");
      // `source` is the opaque column it is; no vendor vocabulary may appear in
      // the CODE, including in a field name or a literal.
      for (const vendor of ["github", "octokit", "gitlab", "bitbucket"]) {
        expect(code.toLowerCase()).not.toContain(vendor);
      }
    }
  });

  it("proves the comment-stripper used above can actually strip", () => {
    // The scanner's own non-vacuity control: a bug that stripped TOO MUCH would
    // make every `not.toContain` above pass vacuously, which is the direction
    // that matters.
    expect(stripComments("// gone\nexport const a = 1;")).toContain(
      "export const a = 1;",
    );
    expect(stripComments("// gone\nexport const a = 1;")).not.toContain("gone");
    const urlish = 'export const u = "http://x"; const b = 2;';
    expect(stripComments(urlish)).toContain("const b = 2;");
    expect(stripComments(urlish)).toContain("http://x");
  });
});
