/**
 * Tests for the protected evidence page (T20) — c4 and c5.
 *
 * THE ASSERTION IS ON THE RENDERED OUTPUT, NEVER ON A STATUS CODE. That is c4
 * verbatim: "An unauthenticated visitor MUST NOT receive the event content in
 * the response body — assert on the rendered output, not on a status code,
 * because a redirect that leaks content in a prefetch would pass a status check."
 * So every refusal test below renders the component and asserts that the event
 * TITLE — a string that only exists in the database — is absent from the markup.
 * A canary event with a distinctive title makes that a real assertion rather
 * than a hopeful one.
 *
 * THE READ IS COUNTED, NOT JUST MOCKED. A test that renders the page and sees
 * no event proves only that nothing was rendered; if the guard also had stopped
 * the read then the page would be "safe" for the wrong reason, and a future
 * change that moved the read above the guard would still show a green suite.
 * So `readCanonicalEvents` is a spy and the refusal tests assert it was NOT
 * called — the guard is load-bearing because the read is unreachable, and both
 * halves are measured.
 *
 * `next/navigation`'s `redirect` is mocked so a refusal can be observed as a
 * thrown control-flow signal rather than as a Next.js response, and the tests
 * assert WHICH destination was requested.
 *
 * `requireSession` is mocked, because what is under test is the PAGE's
 * classification of the guard's three outcomes — the guard's own behaviour is
 * B46's suite's contract and duplicating it here would test nothing. The guard
 * module itself is NOT mocked away in the "calls the seam" test: that one reads
 * the page's imports off disk as text, because the real property is structural
 * (this page imports the seam and nothing that reads a cookie) and a mock cannot
 * establish it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanonicalEvent } from "@/core/events/canonical-event";

/**
 * Repo root, from `src/app/evidence/__tests__` — four levels up, not three.
 * (Counted, not guessed: this file lives at `src/` + `app/` + `evidence/` +
 * `__tests__`, so the root is the parent of `src`.) It exists so the structural
 * tests below can read the page's SOURCE as text; a mock cannot establish which
 * module a page reaches the session through.
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** A title that exists nowhere but this file and the fixture. */
const CANARY_TITLE = "canary-shipped-the-authenticated-things";

/**
 * `release` is measured from `CANONICAL_EVENT_TYPES`, not recalled: the union is
 * `issue | change_proposal | issue_comment | change_review | release |
 * mention`, and a fixture naming a type that does not exist would be a compile
 * error rather than a silently-skipped event. The `source` is a bare opaque
 * string on purpose — no provider vocabulary, even in a test fixture (c8).
 */
const CANARY_EVENT: CanonicalEvent = {
  id: "evt_canary_0001",
  source: "local-demo-source",
  externalId: "canary-1",
  type: "release",
  title: CANARY_TITLE,
  occurredAt: "2026-01-15T10:00:00.000Z",
  metadata: {},
};

/**
 * A session shaped like the guard's real `session` branch.
 *
 * The keys are MEASURED from `typeof auth.$Infer.Session` (T19's instance),
 * not written from memory: `{ session: { id, createdAt, updatedAt, expiresAt,
 * token, userId, ipAddress?, userAgent? }, user: { id, createdAt, updatedAt,
 * name, email?, emailVerified, image? } }`. The dates are real `Date`s because
 * that is what the library returns — a string there would not typecheck, which
 * is the point of measuring rather than guessing. Nothing in this fixture signs
 * anything; the guard only asks whether a session exists.
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
const { default: EvidencePage } = await import("../page");

const mockedRequireSession = vi.mocked(requireSession);
const mockedRead = vi.mocked(readCanonicalEvents);

beforeEach(() => {
  mockedRead.mockResolvedValue({
    ok: true,
    outcome: "ok",
    events: [CANARY_EVENT],
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
    return await renderToStaticMarkup(await EvidencePage());
  } catch (error) {
    if (redirect.mock.calls.length > 0) return "";
    throw error;
  }
}

describe("evidence page — unauthenticated (c4)", () => {
  it("does not render the event content for a visitor with no session", async () => {
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    const html = await render();

    expect(html).not.toContain(CANARY_TITLE);
    expect(html).not.toContain(CANARY_EVENT.id);
    expect(html).not.toContain(CANARY_EVENT.occurredAt);
    // Not even an empty shell that a prefetch could hydrate from.
    expect(html).toBe("");
  });

  it("redirects a signed-out visitor to the sign-in page", async () => {
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    await render();

    expect(redirect).toHaveBeenCalledWith("/sign-in");
  });

  it("never reads the database for a signed-out visitor", async () => {
    // The guard being load-bearing means the read is UNREACHABLE, not merely
    // unused. Without this, a future edit that moved the read above the guard
    // would still render no title (the response is still a redirect) while
    // reading every row in the table.
    mockedRequireSession.mockResolvedValue(NO_SESSION_REFUSAL);

    await render();

    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("does not render event content when there is no session even if the reader would return rows", async () => {
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

describe("evidence page — auth not configured (PM's D-285)", () => {
  it("names the CONFIGURATION fault and never the missing session", async () => {
    mockedRequireSession.mockResolvedValue(UNCONFIGURED_REFUSAL);

    const html = await render();

    // The whole point of the third outcome: a broken .env must not be
    // indistinguishable from a normal signed-out visitor.
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

describe("evidence page — authenticated", () => {
  it("renders the event content for a signed-in visitor", async () => {
    mockedRequireSession.mockResolvedValue(AUTHENTICATED);

    const html = await render();

    expect(html).toContain(CANARY_TITLE);
    expect(html).toContain(CANARY_EVENT.occurredAt);
  });

  it("does not redirect a signed-in visitor", async () => {
    mockedRequireSession.mockResolvedValue(AUTHENTICATED);

    await render();

    expect(redirect).not.toHaveBeenCalled();
  });

  it("renders an explicit empty state rather than nothing when there are no events", async () => {
    // "No evidence yet" and "the guard silently swallowed the read" must not
    // look the same, or the page's own emptiness becomes untestable.
    mockedRequireSession.mockResolvedValue(AUTHENTICATED);
    mockedRead.mockResolvedValue({ ok: true, outcome: "ok", events: [] });

    const html = await render();

    expect(html).toContain("No evidence has been recorded yet");
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
});

/**
 * Strip comments from the page source, leaving code only.
 *
 * NECESSARY, AND MEASURED. The page's own header names the very things the
 * structural tests below forbid — it says "`auth.api.getSession` is not reachable
 * from this file at all" — so a raw `pageSource.not.toContain("auth.api.getSession")`
 * FAILS on a page that has never called it. The first version of these tests did
 * exactly that and went red on the comment, which is the useless direction: the
 * assertion has to be about CODE, not about prose describing code.
 *
 * The walk tracks string, template and comment state so a `//` inside a string
 * does not truncate the line the way a naive `replace(/\/\/.*$/gm, "")` would —
 * and truncating a line is how a real call would be hidden from the scan.
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

describe("evidence page — structural guarantees (c3, c8, c9)", () => {
  const pageSource = readFileSync(
    path.join(REPO_ROOT, "src/app/evidence/page.tsx"),
    "utf8",
  );
  /** Code only: the page's header names the forbidden tokens in prose. */
  const pageCode = stripComments(pageSource);

  it("calls B46's seam rather than reading a cookie itself", () => {
    // Structural, because that is the property: a mock cannot prove which
    // module the page reaches the session through.
    expect(pageSource).toContain('from "@/lib/session-guard"');
    expect(pageCode).toContain("requireSession()");
    // The forbidden second paths, in CODE.
    expect(pageCode).not.toContain("auth.api.getSession");
    expect(pageCode).not.toContain("getSession(");
    expect(pageCode).not.toContain("cookies()");
    expect(pageCode).not.toContain("cookieStore");
  });

  it("reaches no plugin implementation and names no provider", () => {
    expect(pageCode).not.toContain("@/plugins/");
    expect(pageCode).not.toContain("src/plugins/");
    // `source` is rendered as the opaque column it is; no vendor vocabulary may
    // appear in the page's CODE, including in a field name or a literal.
    for (const vendor of ["github", "octokit", "gitlab", "bitbucket"]) {
      expect(pageCode.toLowerCase()).not.toContain(vendor);
    }
  });

  it("reads the secret nowhere and logs no token", () => {
    expect(pageCode).not.toContain("BETTER_AUTH_SECRET");
    expect(pageCode).not.toContain("console.");
    // The only env var this page's module graph reads is the database URL, via
    // the reader, and the reader names the variable only in a refusal message.
    expect(pageCode).not.toContain("process.env.");
  });

  it("proves the comment-stripper used above can actually strip", () => {
    // The scanner's own non-vacuity control. Without it, a bug in
    // `stripComments` that stripped NOTHING would make every `not.toContain`
    // above fail loudly — but a bug that stripped TOO MUCH would make them pass
    // vacuously, which is the direction that matters. So the probe asserts that
    // a comment is removed while code and a `//` inside a string survive.
    expect(stripComments("// gone\nexport const a = 1;")).toContain(
      "export const a = 1;",
    );
    expect(stripComments("// gone\nexport const a = 1;")).not.toContain("gone");
    // A `//` inside a string literal must NOT truncate the line.
    const urlish = 'export const u = "http://x"; const b = 2;';
    expect(stripComments(urlish)).toContain("const b = 2;");
    expect(stripComments(urlish)).toContain("http://x");
  });
});
