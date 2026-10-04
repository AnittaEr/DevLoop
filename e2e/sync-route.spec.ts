import { expect, test } from "@playwright/test";

/**
 * Proves POST /api/sync is REACHABLE over HTTP, not merely unit-tested.
 *
 * This spec deliberately does NOT build a stub seam into the route.
 *
 * `playwright.config.ts` and `.github/workflows/**` are DO NOT TOUCH for this
 * card, so the e2e job cannot be given any extra environment, and
 * `webServer.env` pins only telemetry and CI. Any seam that made the route
 * return a fabricated success would therefore have to be switched on by an
 * environment variable that CI cannot set — i.e. it would be a backdoor in
 * production code that lies about persisted rows, reachable by anyone who can
 * set an env var. That is a worse outcome than the coverage it buys, and it is
 * recorded as a finding on this card rather than shipped.
 *
 * ── WHY THIS FILE ASSERTS A CONTRACT INSTEAD OF ONE OUTCOME ────────────────
 *
 * The first version of this spec asserted `outcome === "database_unconfigured"`.
 * That was a reproducibility bug, and a reviewer's `.env` caught it: QA round 1
 * copied `.env.example` to `.env` — exactly what `.env.example:2` and
 * `db/migrate.ts:16` instruct a developer to do — and the same assertion then
 * failed with `Received: "source_not_configured"`. The ROUTE was correct in both
 * runs; only the expectation was environment-specific. With `DATABASE_URL` set,
 * the `database_unconfigured` short-circuit does not fire and the route
 * correctly falls through to the composition root, which reports the unset
 * `DEVLOOP_REPOSITORY` instead.
 *
 * So this spec now asserts the parts of the contract that hold in EVERY
 * configuration (below), and derives which configuration it landed in from the
 * route's own answer rather than from an ambient variable nobody declared.
 *
 * NOTE ON WHY WE CANNOT JUST SKIP WHEN CONFIGURED. It is tempting to skip
 * unless `process.env.DATABASE_URL` is unset, but that does not work here and
 * the reason is worth recording: this spec runs in the PLAYWRIGHT TEST process,
 * which does not load `.env` at all — only the Next.js server does, at runtime.
 * A developer who configured the project with a `.env` FILE (the documented
 * path) is invisible to a `process.env` check in this file, so a skip guard
 * built on it would not skip, and the original flake would survive it. The
 * branch is therefore read off the response.
 *
 * WHAT IS PROVEN HERE is the part that genuinely needs an HTTP client: the
 * route is mounted under `src/app/api/**`, answers POST, refuses GET, and
 * returns classified, non-leaking JSON whose outcome and status agree. In an
 * unconfigured environment the configuration short-circuit fires over real HTTP,
 * before any credential is resolved and before any outbound request is made.
 * The success and upstream-failure branches are covered by the Vitest suite in
 * `src/app/api/sync/__tests__/handler.test.ts` with an injected registry,
 * writer and the real `syncSource`.
 */

/**
 * The status for each outcome, mirroring `statusFor` in the handler.
 *
 * Asserting the PAIR (outcome, status) rather than a status alone is what makes
 * "each failure mode is distinct" checkable from outside: a caller cannot be
 * handed a 200 for a failure, or a 503 for something that is not the service
 * being unready. Duplicated here rather than imported because this is an
 * HTTP-client assertion about the wire format, and importing the handler would
 * make the spec assert the implementation against itself.
 */
const STATUS_FOR_OUTCOME: Readonly<Record<string, number>> = {
  synced: 200,
  empty: 200,
  database_unconfigured: 503,
  source_not_configured: 503,
  credential_unavailable: 503,
  upstream_rejected: 502,
  upstream_unreachable: 502,
  already_present: 409,
  // 422, not 500: the sync ran and the persistence layer refused the DATA.
  // See the refusal branch in `handler.ts`.
  event_not_persistable: 422,
  internal_error: 500,
};

/** Outcomes that mean the sync completed. Everything else is a failure. */
const SUCCESS_OUTCOMES: ReadonlySet<string> = new Set(["synced", "empty"]);

/**
 * Outcomes reachable when the environment is not fully configured. Whichever
 * one fires, the route refused to do work rather than attempting a sync.
 */
const CONFIGURATION_OUTCOMES: ReadonlySet<string> = new Set([
  "database_unconfigured",
  "source_not_configured",
]);

/** Every key the response body is allowed to carry. */
const BODY_KEYS: ReadonlySet<string> = new Set([
  "ok",
  "outcome",
  "message",
  "source",
  "fetched",
  "persisted",
  "byType",
  "upstreamStatus",
  "idempotent",
  "idempotencyNote",
]);

interface SyncBody {
  ok: boolean;
  outcome: string;
  message: string;
  source: string;
  fetched: number;
  persisted: number;
  byType: Record<string, number>;
  idempotent: boolean;
  idempotencyNote: string;
}

async function postSync(
  request: import("@playwright/test").APIRequestContext,
): Promise<{ status: number; body: SyncBody }> {
  const response = await request.post("/api/sync");
  expect(response.headers()["content-type"]).toContain("application/json");
  return {
    status: response.status(),
    body: (await response.json()) as SyncBody,
  };
}

/**
 * The leak assertions, kept in one place because they are what protects the
 * hard secret-hygiene constraint on this card. Deliberately broad: no
 * credential, no Authorization header, and no upstream or driver text can
 * appear anywhere in the serialised body.
 */
function expectNoSecrets(body: SyncBody): void {
  expect(body).not.toHaveProperty("token");
  expect(body).not.toHaveProperty("error");
  const serialised = JSON.stringify(body).toLowerCase();
  expect(serialised).not.toContain("authorization");
  expect(serialised).not.toContain("bearer ");
  expect(serialised).not.toContain("ghp_");
}

test.describe("POST /api/sync", () => {
  test("answers with a classified body whose outcome and status agree", async ({
    request,
  }) => {
    const { status, body } = await postSync(request);

    // The outcome must be a member of the closed set, in every environment.
    // The containment check is the real assertion: an outcome this spec has
    // never heard of fails here rather than passing silently, and it is what
    // makes the lookup on the next line total.
    expect(Object.keys(STATUS_FOR_OUTCOME)).toContain(body.outcome);
    expect(status).toBe(STATUS_FOR_OUTCOME[body.outcome]);

    // Success and failure agree with each other.
    expect(body.ok).toBe(SUCCESS_OUTCOMES.has(body.outcome));

    // A human-facing message exists, and it is not empty.
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);

    expectNoSecrets(body);
  });

  test("carries only the documented keys, so the body cannot grow with the page", async ({
    request,
  }) => {
    const { body } = await postSync(request);

    for (const key of Object.keys(body)) {
      expect(BODY_KEYS.has(key), `unexpected response key: ${key}`).toBe(true);
    }

    // `byType` is a ROLLUP, and what is correct about it depends on the
    // outcome — so assert the invariant, not one environment's value:
    //  - on any outcome that wrote or read nothing, it must be empty;
    //  - on a success that fetched events, every entry is a positive count and
    //    the total can never exceed `fetched`.
    //
    // An earlier draft of this test asserted `byType == {}` unconditionally,
    // which is the SAME class of bug as the outcome assertion it replaced: it
    // holds in an unconfigured environment and breaks on a configured one, the
    // moment a real sync returns a non-empty rollup.
    expect(typeof body.byType).toBe("object");
    expect(body.byType).not.toBeNull();
    expect(Array.isArray(body.byType)).toBe(false);

    let total = 0;
    for (const [type, count] of Object.entries(body.byType)) {
      expect(typeof type).toBe("string");
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThan(0);
      total += count;
    }

    if (SUCCESS_OUTCOMES.has(body.outcome)) {
      expect(total).toBe(body.fetched);
    } else {
      // Every failure reports zero rows and therefore an empty rollup.
      expect(body.byType).toEqual({});
      expect(total).toBe(0);
    }
  });

  test("tells the caller a repeat call is safe, from the real response", async ({
    request,
  }) => {
    const { body } = await postSync(request);

    // A caller reading only the JSON must be told the truth about retrying.
    // Asserted on every path, success or failure — which is why it does not
    // condition on the outcome the environment produced.
    //
    // Asserted against `true` on a field that is TYPED `boolean`, deliberately.
    // It used to be typed the literal `false` and asserted with `toBe(false)`,
    // so the comparison was a literal against itself and passed no matter what
    // the route did. Widening the type to `boolean` is what makes this a real
    // assertion: the value can only be `true` here if it was read off the
    // response body the route actually produced.
    expect(body.idempotent).toBe(true);
    expect(typeof body.idempotent).toBe("boolean");

    // The note must describe the write path that exists -- an `ON CONFLICT DO
    // UPDATE` upsert on the natural key -- and must not still tell a caller that
    // a repeat call fails. Those are the exact phrases the shipped note carried
    // while the route upserted, so they are pinned as absent.
    expect(body.idempotencyNote).toMatch(/ON CONFLICT DO UPDATE/i);
    expect(body.idempotencyNote).not.toMatch(/not idempotent/i);
    expect(body.idempotencyNote).not.toMatch(/plain INSERT/i);
    expect(body.idempotencyNote).not.toMatch(
      /instead of updating existing rows/i,
    );
  });

  test("refuses GET, so a browser prefetch or crawler cannot trigger a write", async ({
    request,
  }) => {
    const response = await request.get("/api/sync");

    // 405, not 200 and not a silent success: a sync WRITES rows, so answering
    // it to GET would let `<img src>` or a prefetcher cause a write.
    expect(response.status()).toBe(405);
  });

  /**
   * The configuration short-circuit, asserted only when the environment
   * actually produced one.
   *
   * In CI (`DATABASE_URL` unset) this is the whole point of the e2e job: the
   * route refuses to work over real HTTP, before any credential is resolved
   * and before any outbound request. On a fully configured developer machine the
   * route instead attempts a real sync and lands on `synced`/`empty`/
   * `already_present`, so there is no configuration short-circuit to assert —
   * and the test skips with a reason instead of failing for the wrong reason.
   *
   * ── DISCLOSURE: THIS TEST CAN WRITE TO A DEVELOPER'S OWN DATABASE ────────
   * On a machine where `.env` supplies `DATABASE_URL`, `DEVLOOP_REPOSITORY` and
   * a real PAT, the POSTs above perform a REAL sync: real rows into that
   * developer's local `canonical_events` table, and a real authenticated call to
   * GitHub. That is inherent to proving the route reachable over HTTP, which
   * this card requires, and it CANNOT be neutralised from here: the server's
   * environment is fixed by `playwright.config.ts`, which is DO NOT TOUCH.
   *
   * A second local run does NOT report `already_present`: the write path is an
   * `ON CONFLICT DO UPDATE` upsert on `UNIQUE (source, external_id)`, so a
   * second run over the same rows converges and is reported as `synced`. An
   * earlier version of this comment claimed a second run reports
   * `already_present`; that was true when the write path was a plain INSERT and
   * became false when T16 added the upsert — the class of drift this card exists
   * to remove. `already_present` remains reachable, but only for a
   * primary-key-only collision, which a repeat of the same page cannot produce.
   */
  test("refuses to sync before resolving a credential when the environment is unconfigured", async ({
    request,
  }) => {
    const { status, body } = await postSync(request);

    test.skip(
      !CONFIGURATION_OUTCOMES.has(body.outcome),
      `environment is fully configured, so the route attempted a real sync and reported "${body.outcome}" — there is no configuration short-circuit to assert here`,
    );

    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.persisted).toBe(0);
    expect(body.fetched).toBe(0);
    expect(CONFIGURATION_OUTCOMES.has(body.outcome)).toBe(true);
    expectNoSecrets(body);
  });
});
