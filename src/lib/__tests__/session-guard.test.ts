/**
 * Unit tests for the reusable session guard (B46).
 *
 * THE THREE OUTCOMES ARE THE POINT OF THIS FILE. A guard that answers "not
 * authenticated" for a server whose auth is UNCONFIGURED is the defect this
 * suite exists to catch, and it is the one a suite written only against "secret
 * set, no cookie" would never see — that case returns a clean `null` and passes
 * either way. So both failure states are driven explicitly here, and the last
 * test in the file is the import-without-a-request one, because a module that
 * throws at import time breaks `next build` and `bun run test` in a way that
 * looks nothing like an auth bug.
 *
 * `getSession()` is mocked rather than exercised, because what is under test is
 * the guard's CLASSIFICATION of what the helper returns and throws — the
 * helper's own behaviour is T19's suite's contract. What is deliberately NOT
 * mocked is `AuthSecretMissingError`, which is imported from the real module: a
 * guard that matched the wrong error class would refuse a real misconfiguration
 * by accident and this file would still be green.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthSecretMissingError } from "@/lib/auth";

import { requireSession, SESSION_GUARD_OUTCOMES } from "@/lib/session-guard";

/** A session shaped like the helper's real return. Never used for its content. */
const FAKE_SESSION = {
  session: { id: "session-1", userId: "user-1", token: "not-a-real-token" },
  user: { id: "user-1", email: "local@example.invalid" },
} as unknown as Awaited<
  ReturnType<typeof import("@/lib/auth-session").getSession>
>;

/**
 * A 32-byte throwaway secret value. Nothing signs anything with it here — the
 * guard only asks the helper whether a session exists — and it exists so the
 * "configured" cases are not accidentally reading an unconfigured environment.
 */
const THROWAWAY_SECRET = "b46-test-only-secret-not-a-real-credential";

vi.mock("@/lib/auth-session", () => ({
  getSession: vi.fn(),
}));

const { getSession } = await import("@/lib/auth-session");
const mockedGetSession = vi.mocked(getSession);

const ORIGINAL_SECRET = process.env.BETTER_AUTH_SECRET;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_SECRET;
  vi.clearAllMocks();
});

describe("requireSession", () => {
  it("reports a valid session as authenticated and hands it back", async () => {
    process.env.BETTER_AUTH_SECRET = THROWAWAY_SECRET;
    mockedGetSession.mockResolvedValue(FAKE_SESSION);

    const result = await requireSession();

    expect(result.ok).toBe(true);
    if (result.ok !== true)
      throw new Error("expected the authenticated branch");
    expect(result.outcome).toBe(SESSION_GUARD_OUTCOMES.authenticated);
    expect(result.session).toBe(FAKE_SESSION);
  });

  it("refuses a request carrying no session with 401 and a NAMED condition", async () => {
    process.env.BETTER_AUTH_SECRET = THROWAWAY_SECRET;
    // What a CONFIGURED helper returns when there is simply no cookie. This is
    // the case the whole file could be written wrong against.
    mockedGetSession.mockResolvedValue(null);

    const result = await requireSession();

    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error("expected a refusal");
    expect(result.status).toBe(401);
    expect(result.outcome).toBe(SESSION_GUARD_OUTCOMES.sessionRequired);
    expect(result.body.outcome).toBe(SESSION_GUARD_OUTCOMES.sessionRequired);
    expect(result.body.message).toMatch(/session/i);
    // No work happened, and the body says so for a caller reading only JSON.
    expect(result.body.persisted).toBe(0);
    expect(result.body.fetched).toBe(0);
  });

  it("refuses with 503 — NOT 401 — when auth is unconfigured", async () => {
    // The misconfiguration the helper refuses to answer for. Reporting this as
    // "nobody is signed in" is the silent-default failure D2/D5 were raised to
    // kill, so the status and the named outcome are both asserted.
    mockedGetSession.mockRejectedValue(
      new AuthSecretMissingError(
        "BETTER_AUTH_SECRET is not set. Auth cookies cannot be signed without it.",
      ),
    );

    const result = await requireSession();

    expect(result.ok).toBe(false);
    if (result.ok !== false) throw new Error("expected a refusal");
    expect(result.status).toBe(503);
    expect(result.status).not.toBe(401);
    expect(result.outcome).toBe(SESSION_GUARD_OUTCOMES.authNotConfigured);
    expect(result.body.message).toMatch(/BETTER_AUTH_SECRET/);
  });

  it("tells the two refusals apart with different statuses and different text", async () => {
    // The property above, stated as a comparison so a future collapse of the
    // two branches into one is caught even if both individual tests were edited.
    mockedGetSession.mockResolvedValueOnce(null);
    const noSession = await requireSession();

    mockedGetSession.mockRejectedValueOnce(
      new AuthSecretMissingError("BETTER_AUTH_SECRET is not set."),
    );
    const unconfigured = await requireSession();

    if (noSession.ok !== false || unconfigured.ok !== false) {
      throw new Error("expected two refusals");
    }
    expect(noSession.status).not.toBe(unconfigured.status);
    expect(noSession.outcome).not.toBe(unconfigured.outcome);
    expect(noSession.body.message).not.toBe(unconfigured.body.message);
  });

  it("rethrows anything that is not the auth misconfiguration", async () => {
    // A guard that caught everything would report a database or adapter bug as
    // "nobody is signed in" and hide it behind a 401 forever.
    const boom = new Error("connection terminated unexpectedly");
    mockedGetSession.mockRejectedValue(boom);

    await expect(requireSession()).rejects.toBe(boom);
  });

  it("imports without a Next.js request scope and without a configured secret", async () => {
    // `next build` and `bun run test` both import this module with no `.env` and
    // no request in flight. If anything ran at module scope this throws, and the
    // failure would present as an unrelated build or collection error.
    delete process.env.BETTER_AUTH_SECRET;
    vi.resetModules();

    const fresh = await import("@/lib/session-guard");

    expect(typeof fresh.requireSession).toBe("function");
    expect(Object.keys(fresh.SESSION_GUARD_OUTCOMES).sort()).toEqual([
      "authNotConfigured",
      "authenticated",
      "sessionRequired",
    ]);
  });

  it("never reads, returns or echoes the secret value", async () => {
    process.env.BETTER_AUTH_SECRET = THROWAWAY_SECRET;
    mockedGetSession.mockResolvedValue(null);
    mockedGetSession.mockRejectedValue(
      new AuthSecretMissingError("BETTER_AUTH_SECRET is not set."),
    );

    const results = [await requireSession(), await requireSession()];

    for (const result of results) {
      if (result.ok !== false) throw new Error("expected refusals");
      expect(JSON.stringify(result.body)).not.toContain(THROWAWAY_SECRET);
    }
  });
});
