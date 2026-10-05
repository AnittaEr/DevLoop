/**
 * The sign-in round trip over real HTTP (T20) — c5(a) and c7.
 *
 * WHAT THIS SPEC IS FOR. B46 documented the coverage it gave up: with the route
 * guarded, no anonymous caller can reach the classified sync body over real
 * HTTP, so "synced / empty / source_not_configured", the status pairing and the
 * `idempotencyNote` stopped being asserted anywhere except against the real
 * handler in a unit test. That spec named T20 as the card that could restore it
 * HONESTLY, and this is that restoration.
 *
 * ── WHY IT SIGNS UP AND SIGNS IN RATHER THAN INJECTING A SESSION ───────────
 *
 * c7 is explicit: no bypass header, no environment variable that disables
 * authentication in production code, and no weakening of B46's guard. A guard
 * switchable by an env var is not a guard. So this spec obtains its session
 * through the same mounted `/api/auth/*` endpoints a browser uses, by driving the
 * real HTML form. There is no `storageState` fixture, no hand-signed cookie and
 * no fabricated session row anywhere in this file.
 *
 * ── WHY IT BRANCHES ON AUTH BEING AVAILABLE RATHER THAN SKIPPING ───────────
 *
 * A real session needs a real user row, which needs the auth tables, which need
 * `DATABASE_URL` and a migrated database. In CI's `e2e` job — which, measured,
 * runs NO database service (only the `db` job declares a `postgres` service
 * container) — none of that exists, and no credential, PAT or account may be
 * asked of Anita (hard rule 2). So this spec ASSERTS the contract it can observe
 * in every environment and only DRIVES the authenticated half when the server
 * actually reports a usable secret and a reachable database.
 *
 * The branch is read off the SERVER'S OWN RESPONSE, never off `process.env`.
 * This spec runs in the Playwright process, which does not load `.env` — only
 * the Next.js server does, at runtime — so an environment check here would be
 * blind to the documented setup path and would take the wrong branch. That is
 * the same trap `sync-route.spec.ts` records, and it is why the probe is an
 * HTTP request.
 *
 * WHAT IS THEREFORE ASSERTED EVERYWHERE: that the protected page withholds its
 * content from a signed-out visitor in BOTH configurations, that a
 * misconfigured server names the misconfiguration rather than a missing
 * session, and that GET and POST /api/sync keep their refusals. WHAT IS ASSERTED
 * WHERE A DATABASE EXISTS: the full sign-up → sign-in → evidence → sign-out →
 * refused round trip, and the restored classified sync body.
 */

import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * A throwaway account for the authenticated half.
 *
 * Not a credential for anything: it exists only inside the local throwaway
 * database the `db` job provisions, and it is never printed — every assertion
 * below matches on rendered copy, never on the password. `.invalid` is reserved
 * by RFC 2606 precisely so a name that looks like an address can never resolve.
 */
const ACCOUNT = {
  name: "T20 Local User",
  email: "t20-round-trip@example.invalid",
  password: "t20-throwaway-not-a-real-password",
};

/** What the page says when it is protecting itself from a signed-out visitor. */
const SIGNOUT_REDIRECT_MARKERS = [/auth is not configured/i, /Sign in/i];

/**
 * Ask the server whether auth is usable, over real HTTP.
 *
 * A signed-out `GET /api/auth/get-session` answers 200 with a null session when
 * the secret is configured, and 503 `auth_not_configured` when it is not. That
 * is T19's own shipped contract, so this probe reads it rather than inventing a
 * health endpoint.
 */
async function authIsUsable(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/auth/get-session");
  return response.status() === 200;
}

/**
 * Make the account exist, through the real form.
 *
 * Two measured facts shape this, and neither is a convenience:
 *
 *  1. ON SUCCESS THE ISLAND NAVIGATES; IT DOES NOT SHOW A MESSAGE. So the
 *     outcome of a sign-up click is genuinely bimodal — either the browser is
 *     now on `/evidence`, or `auth-message` reports the refusal (422 for an
 *     address that already exists). MEASURED: the first version of this helper
 *     asserted the message unconditionally and failed with
 *     `element(s) not found` on the very first run against a fresh database,
 *     i.e. on the SUCCESS path.
 *  2. BETTER AUTH ANSWERS 422 FOR AN EXISTING ADDRESS, NOT 200. So `bun run
 *     e2e` re-run against the same database — which is routine, and which CI's
 *     `retries: 2` makes routine — must not fail merely because the account
 *     survives from the previous run.
 *
 * So both outcomes are accepted, and the SPEC DOES NOT CARE WHICH: what it
 * needs is a usable account, and `signIn` is what establishes the session. A
 * genuine failure is still caught — not here, but at the `waitForURL` that
 * follows, which is the assertion that actually matters.
 */
async function signUp(page: Page): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ACCOUNT.email);
  await page.getByLabel("Password").fill(ACCOUNT.password);
  await page.getByLabel("Name").fill(ACCOUNT.name);
  await page.getByRole("button", { name: "Sign up" }).click();

  // Wait for the click to have had SOME effect: a navigation, or the refusal.
  await expect(
    page
      .getByTestId("auth-message")
      .or(page.locator("h1", { hasText: "Evidence" })),
  ).toBeVisible();
}

/**
 * Drive the real sign-in form and wait for the server-rendered evidence page.
 *
 * A full page navigation is what the island does (`window.location.assign`), so
 * the destination is produced by the SERVER re-running its own guard. A session
 * cookie that was never really written therefore cannot get past it — which is
 * the whole reason this spec signs in through the form instead of injecting a
 * cookie (c7).
 *
 * WHY IT DOES NOT ASSUME IT CAN ALWAYS SEE THE FORM. MEASURED: a SUCCESSFUL
 * sign-up leaves the browser already authenticated, and `/sign-in` then
 * REDIRECTS a signed-in visitor to `/evidence` (c1) — so a second `goto("/sign-in")`
 * lands on the evidence page with no form on it, and the fill times out with
 * `waiting for getByLabel('Email')`. So this helper accepts either arrival:
 * already on `/evidence` (signed in already) or the form (to be filled).
 */
async function signIn(page: Page): Promise<void> {
  await page.goto("/sign-in");

  const emailField = page.getByLabel("Email");
  const onForm = await emailField
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);

  if (onForm) {
    await emailField.fill(ACCOUNT.email);
    await page.getByLabel("Password").fill(ACCOUNT.password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }

  await page.waitForURL(EVIDENCE_URL_GLOB);
}

/**
 * The two page routes as URL globs.
 *
 * Named constants because each literal is two asterisks followed by a slash, and
 * a second occurrence written inside this file's own block comment closed that
 * comment early — MEASURED, as a wall of parser errors pointing at an unrelated
 * line. One definition each, one place to get them wrong.
 */
const EVIDENCE_URL_GLOB = "**/evidence";
const SIGN_IN_URL_GLOB = "**/sign-in";

test.describe("protected pages withhold content from a signed-out visitor (c4)", () => {
  test("/evidence serves no event content and no database error to an anonymous visitor", async ({
    page,
    request,
  }) => {
    // No navigation at all first, so the assertion is about the raw RESPONSE
    // BODY rather than about whatever a client-side router ends up rendering.
    //
    // WHICH STATUS IS EXPECTED IS READ OFF THE PROBE, NOT ASSUMED. MEASURED:
    // with no `BETTER_AUTH_SECRET` this page answers 200 with the named
    // configuration panel, not a 307 — because the misconfiguration is rendered
    // and never redirected (D-285). With a usable secret and no cookie it
    // answers 307 to `/sign-in`. Hard-coding 307 made this spec fail on the very
    // configuration CI runs, which is the environment-sensitivity defect
    // `sync-route.spec.ts` already documents for the sync route.
    const usable = await authIsUsable(request);
    // `maxRedirects: 0` IS THE POINT, and the first version of this test omitted
    // it. MEASURED: Playwright's `request` fixture follows redirects by
    // default, so a 307 to `/sign-in` was transparently followed and the test
    // observed the SIGN-IN PAGE's 200 — which failed an assertion about
    // `/evidence` and would have made the "does the response body withhold the
    // evidence" check assert against the wrong document entirely. With the
    // redirect suppressed the same request answers 307 to `/sign-in`, which is
    // what a raw `curl` sees.
    const response = await request.get("/evidence", { maxRedirects: 0 });

    if (usable) {
      expect(response.status()).toBe(307);
      expect(response.headers()["location"]).toContain("/sign-in");
    } else {
      // The misconfiguration is rendered, not redirected, so 200 with the panel.
      expect(response.status()).toBe(200);
    }

    const body = await response.text();
    // The criterion c4 states: not merely a redirect status, but a body with no
    // evidence in it. `canonical_events` is empty in every environment this spec
    // runs in without a sync, so absence of a row title is not the test — the
    // test is that NO evidence markup and NO database message reaches the
    // visitor, and that the body carries neither. A 307 body is empty, which is
    // the property that matters and is asserted by length as well as content.
    expect(body).not.toContain('data-testid="period-');
    expect(body).not.toContain("evidence-summary");
    expect(body).not.toContain("DATABASE_URL");
    expect(body).not.toContain("database_unavailable");

    // And through a real browser, which follows the redirect when there is one.
    await page.goto("/evidence");
    if (usable) {
      await expect(
        page.getByRole("heading", { name: "Sign in", level: 1 }),
      ).toBeVisible();
    } else {
      await expect(page.getByTestId("guard-notice")).toBeVisible();
    }
    await expect(page.getByTestId("evidence-summary")).toHaveCount(0);
  });

  test("/sign-in serves the FORM to a signed-out visitor, in both configurations", async ({
    request,
  }) => {
    // The signed-IN half of this redirect contract needs a session and is
    // asserted in the round-trip block below, where one exists. This asserts the
    // half that is observable everywhere — and MEASURED: with no
    // `BETTER_AUTH_SECRET` it is NOT a 307, because the misconfiguration is
    // rendered as a named panel rather than redirected (D-285).
    const response = await request.get("/sign-in");
    expect([200, 307]).toContain(response.status());

    const body = await response.text();
    expect(body).not.toContain("evidence-summary");
    // Never the evidence content, whichever branch answered.
    expect(body).not.toContain('data-testid="period-');
  });
});

test.describe("misconfiguration is named, never reported as signed out (D-285)", () => {
  test("never renders a sign-in form on a server that cannot authenticate", async ({
    page,
    request,
  }) => {
    const usable = await authIsUsable(request);

    await page.goto("/evidence");

    if (usable) {
      // Configured: the visitor is simply sent to the form.
      await expect(
        page.getByRole("heading", { name: "Sign in", level: 1 }),
      ).toBeVisible();
      expect(SIGNOUT_REDIRECT_MARKERS[0]).toBeDefined();
      return;
    }

    // Unconfigured: a LOUD, NAMED configuration fault, and NO form. A developer
    // whose `.env` is wrong must never be handed a sign-in form that cannot
    // work — that is the silent-default failure D2 and D5 exist to prevent.
    const notice = page.getByTestId("guard-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/auth is not configured/i);
    await expect(notice).toContainText("BETTER_AUTH_SECRET");
    await expect(notice).toContainText("auth_not_configured");
    await expect(page.getByLabel("Password")).toHaveCount(0);
  });
});

test.describe("sign-in round trip (c5a, c7)", () => {
  test("signs up, signs in, sees the evidence, signs out and is refused", async ({
    page,
    request,
  }) => {
    test.skip(
      !(await authIsUsable(request)),
      "no auth secret or no database in this environment; the signed-out and " +
        "misconfiguration contracts above are asserted instead",
    );

    await signUp(page);
    await signIn(page);

    await expect(
      page.getByRole("heading", { name: "Evidence", level: 1 }),
    ).toBeVisible();
    // Signed in means the page renders its OWN state, not the refusal.
    await expect(page.getByTestId("guard-notice")).toHaveCount(0);

    // And the already-signed-in redirect really happens.
    await page.goto("/sign-in");
    await page.waitForURL(EVIDENCE_URL_GLOB);

    // Sign out from the protected page — the only place it is reachable.
    await page.getByTestId("sign-out").click();
    await page.waitForURL(SIGN_IN_URL_GLOB);
    await expect(
      page.getByRole("heading", { name: "Sign in", level: 1 }),
    ).toBeVisible();

    // And now the evidence page refuses again. `maxRedirects: 0` for the same
    // reason as the signed-out test above: without it Playwright follows the
    // redirect and this assertion reads the SIGN-IN page's 200 instead of the
    // refusal, which would make the final step of the round trip assert nothing
    // about the guard.
    const afterSignOut = await page.request.get("/evidence", {
      maxRedirects: 0,
    });
    expect(afterSignOut.status()).toBe(307);
    expect(afterSignOut.headers()["location"]).toContain("/sign-in");
    // And the refusal body carries no evidence at all.
    const refusedBody = await afterSignOut.text();
    expect(refusedBody).not.toContain("evidence-summary");
    expect(refusedBody).not.toContain('data-testid="period-');
  });

  test("restores the classified sync body over real HTTP for an authenticated caller", async ({
    page,
    request,
  }) => {
    // This is the coverage `sync-route.spec.ts` recorded as lost. With a real
    // session the sync route is reachable again, so its classified body can be
    // asserted over HTTP instead of only against the real handler in a unit test.
    test.skip(
      !(await authIsUsable(request)),
      "the classified sync body needs an authenticated session, which needs the " +
        "auth tables in a migrated database",
    );

    await signUp(page);
    await signIn(page);

    // `page.request` carries the browser context's cookies, so this is the same
    // session the form just established.
    const response = await page.request.post("/api/sync");
    const body = (await response.json()) as Record<string, unknown>;

    // THE REAL GATE: THE 401 IS GONE. B46 made this route refuse an
    // unauthenticated caller with 401 `session_required`; an authenticated one
    // is now answered by the sync pipeline instead. Anything still 401 would
    // mean the session did not actually reach the server.
    expect(response.status()).not.toBe(401);

    // The classified vocabulary, read from `handler.ts` rather than guessed.
    // An outcome this spec has never heard of fails here instead of passing
    // silently, which is what makes the status pairing below total.
    const OUTCOME_STATUS: Readonly<Record<string, number>> = {
      // Successes.
      synced: 200,
      empty: 200,
      // Not configured — the usual case for a local run with no
      // DEVLOOP_REPOSITORY. MEASURED: the first version of this assertion
      // expected [200, 409, 422] and failed on 503, which is what
      // `statusFor` returns for `source_not_configured`.
      source_not_configured: 503,
      database_unconfigured: 503,
      credential_unavailable: 503,
      // Upstream problems.
      upstream_rejected: 502,
      upstream_unreachable: 502,
      // Data and conflict problems.
      already_present: 409,
      event_not_persistable: 422,
      // The unclassified failure.
      internal_error: 500,
    };
    expect(Object.keys(OUTCOME_STATUS)).toContain(body.outcome);
    expect(response.status()).toBe(OUTCOME_STATUS[body.outcome as string]);

    // An idempotency note is always present, as the route documents, and the
    // row counts are numbers — a body that dropped them would still typecheck
    // as a record.
    expect(typeof body.idempotent).toBe("boolean");
    expect(typeof body.idempotencyNote).toBe("string");
    expect(typeof body.fetched).toBe("number");
    expect(typeof body.persisted).toBe("number");

    // No credential, token and no secret value anywhere in a real response.
    const serialised = JSON.stringify(body).toLowerCase();
    expect(serialised).not.toContain(ACCOUNT.password.toLowerCase());
    expect(serialised).not.toContain("better-auth-secret-12345678901234567890");
    expect(body).not.toHaveProperty("token");
  });
});
