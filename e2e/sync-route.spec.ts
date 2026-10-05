import { expect, test } from "@playwright/test";

/**
 * Proves POST /api/sync is REACHABLE over HTTP, not merely unit-tested.
 *
 * This spec deliberately does NOT build a stub seam into the route.
 *
 * `playwright.config.ts` and `.github/workflows/**` carry no way to hand the
 * server a session: `webServer.env` pins only telemetry and CI, and no
 * `use.storageState` exists. Any seam that made the route return a fabricated
 * success would therefore have to be switched on by an environment variable —
 * i.e. a backdoor in production code that lies about persisted rows, reachable
 * by anyone who can set an env var. That is a worse outcome than the coverage it
 * buys, and it is recorded as a finding rather than shipped.
 *
 * ── WHAT CHANGED WHEN THE ROUTE GOT AN AUTH GUARD (B46) ─────────────────────
 * The route now requires a session, so an anonymous POST over real HTTP no
 * longer reaches the pipeline at all: it is refused with a NAMED condition
 * before any registry is resolved and before any row is written. The five tests
 * that drove `postSync` as an anonymous caller therefore had to change, and
 * this card chose option (ii) of c9 over option (i):
 *
 *   (i) give the spec a real authenticated session;
 *  (ii) assert the NEW unauthenticated contract, and keep the classified-body
 *       assertions only for a request that IS authenticated.
 *
 * WHY (ii). A real session needs a real user, and getting one means EITHER
 * registering a user through Better Auth's sign-up endpoint — which this card's
 * OUT OF SCOPE forbids, explicitly — OR hand-rolling a signed session cookie and
 * a session row against a throwaway database. The second is the exact thing
 * this spec's own header above refuses to do: a fabricated identity that makes
 * the route report work it did not do. T20 (`t_911d21fa`) builds the sign-in UI
 * and can then drive this spec authenticated for real; until then, a fabricated
 * credential is the wrong trade.
 *
 * WHAT IS THEREFORE NOT PROVEN HERE ANY MORE, STATED PLAINLY. The classified
 * body (`synced` / `empty` / `source_not_configured` / …), its status pairing and
 * its `idempotencyNote` are no longer asserted over real HTTP, because no
 * anonymous caller can reach them. They are still asserted against the real
 * handler in `src/app/api/sync/__tests__/handler.test.ts`, which drives the
 * actual `handleSyncRequest` with the real `syncSource`. What this file proves
 * over HTTP is what genuinely needs an HTTP client: the route is mounted under
 * `src/app/api/**`, answers POST, refuses an unauthenticated caller with a named
 * condition and no work done, and still refuses GET.
 *
 * ── WHY THIS FILE ASSERTS A CONTRACT INSTEAD OF ONE OUTCOME ────────────────
 *
 * The first version of this spec asserted `outcome === "database_unconfigured"`.
 * That was a reproducibility bug, and a reviewer's `.env` caught it: QA round 1
 * copied `.env.example` to `.env` — exactly what `.env.example:2` and
 * `db/migrate.ts:16` instruct a developer to do — and the same assertion then
 * failed with `Received: "source_not_configured"`. The ROUTE was correct in both
 * runs; only the expectation was environment-specific.
 *
 * The same environment-sensitivity now decides the REFUSAL STATUS, and for a
 * reason the route documents: an anonymous POST answers 401 `session_required`
 * when the server has a usable `BETTER_AUTH_SECRET`, and 503
 * `auth_not_configured` when it has none — because a server that cannot tell who
 * anyone is must not report that nobody is signed in. So the branch is again read
 * off the response, never off an ambient variable nobody declared.
 *
 * NOTE ON WHY WE CANNOT JUST SKIP WHEN CONFIGURED. It is tempting to skip
 * unless `process.env.DATABASE_URL` is unset, but that does not work here and the
 * reason is worth recording: this spec runs in the PLAYWRIGHT TEST process,
 * which does not load `.env` at all — only the Next.js server does, at runtime.
 * A developer who configured the project with a `.env` FILE (the documented
 * path) is invisible to a `process.env` check in this file, so a skip guard
 * built on it would not skip, and the original flake would survive it. The
 * branch is therefore read off the response.
 */

/**
 * The refusal this spec asserts, and the ONE thing that varies by environment.
 *
 * Both members are refusals of the same request for the same reason — no
 * session — and both are fixed literals from `src/lib/session-guard.ts`. The
 * containment check is the real assertion: an outcome this spec has never heard
 * of fails here rather than passing silently, which is what also makes the
 * per-outcome assertions below total.
 */
const REFUSAL_STATUS_FOR_OUTCOME: Readonly<Record<string, number>> = {
  // Auth works; this request simply carries no session cookie.
  session_required: 401,
  // Auth cannot answer at all: BETTER_AUTH_SECRET is missing or default.
  auth_not_configured: 503,
};

/**
 * Outcomes that mean the sync completed. Everything else is a failure.
 *
 * Kept because the refusal assertions below still state that NO work happened,
 * and that statement is a comparison against this set.
 */
const SUCCESS_OUTCOMES: ReadonlySet<string> = new Set(["synced", "empty"]);

/**
 * Every key the refusal body is allowed to carry.
 *
 * A closed set, so a guard that started echoing something new — a session id, a
 * user email, a header — fails here instead of shipping quietly.
 */
const REFUSAL_BODY_KEYS: ReadonlySet<string> = new Set([
  "ok",
  "outcome",
  "message",
  "fetched",
  "persisted",
]);

interface SyncRefusalBody {
  ok: boolean;
  outcome: string;
  message: string;
  fetched: number;
  persisted: number;
}

async function postSync(
  request: import("@playwright/test").APIRequestContext,
): Promise<{ status: number; body: SyncRefusalBody }> {
  const response = await request.post("/api/sync");
  expect(response.headers()["content-type"]).toContain("application/json");
  // Nothing about a refusal may be cacheable: it is a statement about this
  // request's headers, and a cached 401 would outlive the session.
  expect(response.headers()["cache-control"]).toContain("no-store");
  return {
    status: response.status(),
    body: (await response.json()) as SyncRefusalBody,
  };
}

/**
 * The leak assertions, kept in one place because they are what protects the
 * hard secret-hygiene constraint on this card. Deliberately broad: no
 * credential, no Authorization header, and no secret VALUE can appear anywhere
 * in the serialised body — the misconfiguration message names the VARIABLE and
 * must never carry what was set to it.
 */
function expectNoSecrets(body: SyncRefusalBody): void {
  expect(body).not.toHaveProperty("token");
  expect(body).not.toHaveProperty("error");
  const serialised = JSON.stringify(body).toLowerCase();
  expect(serialised).not.toContain("authorization");
  expect(serialised).not.toContain("bearer ");
  expect(serialised).not.toContain("ghp_");
  expect(serialised).not.toContain("better-auth-secret-12345678901234567890");
}

test.describe("POST /api/sync", () => {
  test("refuses an unauthenticated caller with a named condition and does no work", async ({
    request,
  }) => {
    const { status, body } = await postSync(request);

    // The containment check is the real assertion: an outcome this spec has
    // never heard of fails here rather than passing silently, and it is what
    // makes the lookup on the next line total.
    expect(Object.keys(REFUSAL_STATUS_FOR_OUTCOME)).toContain(body.outcome);
    expect(status).toBe(REFUSAL_STATUS_FOR_OUTCOME[body.outcome]);

    // A refusal is never a success, in either environment.
    expect(body.ok).toBe(false);
    expect(SUCCESS_OUTCOMES.has(body.outcome)).toBe(false);

    // NO WORK HAPPENED. Not "the response said zero" — the row counts are the
    // only evidence available from outside, so they are asserted as zero, and
    // the fact that the pipeline was never entered at all is covered by
    // `route-auth.test.ts`, which counts the calls into the real handler.
    expect(body.fetched).toBe(0);
    expect(body.persisted).toBe(0);

    // A human-facing message exists, and it is not empty.
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);

    expectNoSecrets(body);
  });

  test("distinguishes 'nobody is signed in' from 'auth is not configured'", async ({
    request,
  }) => {
    const { status, body } = await postSync(request);

    // Whichever refusal this environment produced, it must name its own
    // condition — the defect this card was raised to prevent is a misconfigured
    // server reporting itself as a signed-out user.
    if (body.outcome === "auth_not_configured") {
      expect(status).toBe(503);
      expect(body.message).toMatch(/BETTER_AUTH_SECRET/);
    } else {
      expect(body.outcome).toBe("session_required");
      expect(status).toBe(401);
      expect(body.message).toMatch(/session/i);
    }
  });

  test("carries only the documented keys, so the body cannot grow with the page", async ({
    request,
  }) => {
    const { body } = await postSync(request);

    for (const key of Object.keys(body)) {
      expect(
        REFUSAL_BODY_KEYS.has(key),
        `unexpected response key: ${key}`,
      ).toBe(true);
    }

    // The refusal body carries no rollup at all — asserted from OUTSIDE the
    // closed-key loop above, so a `byType` that crept back in would fail there
    // and this would only be reading the same fact twice.
    expect("byType" in body).toBe(false);
  });

  test("refuses GET, so a browser prefetch or crawler cannot trigger a write", async ({
    request,
  }) => {
    const response = await request.get("/api/sync");

    // 405, not 200 and not a silent success: a sync WRITES rows, so answering
    // it to GET would let `<img src>` or a prefetcher cause a write. It is also
    // NOT 401 — the guard must not turn every method into an auth failure,
    // which would be a 401 produced by method mismatch rather than by the
    // missing session.
    expect(response.status()).toBe(405);
    expect(response.status()).not.toBe(401);
  });
});
