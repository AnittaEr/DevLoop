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
 * What is proven here is the part that genuinely needs an HTTP client to prove:
 * the route exists, is mounted under `src/app/api/**`, answers POST, refuses
 * GET, and returns a classified, non-leaking JSON body. In the e2e environment
 * `DATABASE_URL` is unset, so the route short-circuits to
 * `database_unconfigured` — which is itself the assertion that matters: the
 * short-circuit happens over real HTTP, before any credential is resolved and
 * before any outbound request is made. The success and upstream-failure
 * branches are covered by the Vitest suite in
 * `src/app/api/sync/__tests__/handler.test.ts` with an injected registry,
 * writer and sync function.
 */
test.describe("POST /api/sync", () => {
  test("is reachable over HTTP and classifies a missing DATABASE_URL", async ({
    request,
  }) => {
    const response = await request.post("/api/sync");

    expect(response.status()).toBe(503);
    expect(response.headers()["content-type"]).toContain("application/json");

    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.outcome).toBe("database_unconfigured");
    // The count a human needs in order to trust the answer.
    expect(body.persisted).toBe(0);
    expect(body.fetched).toBe(0);
    // Never a credential, never an upstream fragment.
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("error");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("authorization");
  });

  test("always tells the caller the route is not idempotent", async ({
    request,
  }) => {
    const response = await request.post("/api/sync");
    const body = await response.json();

    // A caller reading only the JSON must not mistake this for safe-to-retry.
    expect(body.idempotent).toBe(false);
    expect(body.idempotencyNote).toContain("already_present");
  });

  test("refuses GET, so a browser prefetch or crawler cannot trigger a write", async ({
    request,
  }) => {
    const response = await request.get("/api/sync");

    // 405, not 200 and not a silent success: a sync WRITES rows, so answering
    // it to GET would let `<img src>` or a prefetcher cause a write.
    expect(response.status()).toBe(405);
  });
});
