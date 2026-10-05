/**
 * The `[...all]` route's secret guard (T19, round-1 defect D2).
 *
 * RUNS WITH NO DATABASE AND NO `.env`. The point of the guard is that a
 * misconfigured environment is refused at REQUEST time, so the only behaviour
 * worth testing offline is the refusal and the shape of the exports. A request
 * WITH a valid secret reaches Better Auth's handler and therefore a real
 * database, which is the db-backed suite's job (`db/__tests__/auth-tables.test.ts`),
 * not this file's.
 *
 * WHY AN OFFLINE TEST OF THE ROUTE AT ALL. QA's D2 probe read the shipped
 * instance's resolved secret and found the published default. A refusal that is
 * only asserted against the helper, never against the handler the client
 * actually calls, would be exactly the "asserted rather than derived" defect
 * again one layer up — so this drives the exported route handler.
 * WHY THIS TEST LIVES OUTSIDE `[...all]/`. Next.js App Router treats every
 * directory under `app/` as a route, so a `__tests__` folder nested inside the
 * catch-all segment would itself become a route and appear in the build
 * manifest. The import below reaches across into the sibling directory, which is
 * what the other route suites in this repo already do.
 */

import { afterEach, describe, expect, it } from "vitest";

import { DELETE, GET, PATCH, POST, PUT } from "../[...all]/route";

const ORIGINAL_SECRET = process.env.BETTER_AUTH_SECRET;
const ORIGINAL_SIGN_UP_FLAG = process.env.DEVLOOP_ALLOW_SIGN_UP;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_SIGN_UP_FLAG === undefined)
    delete process.env.DEVLOOP_ALLOW_SIGN_UP;
  else process.env.DEVLOOP_ALLOW_SIGN_UP = ORIGINAL_SIGN_UP_FLAG;
});

/** Every HTTP method Better Auth's router can serve under `/api/auth/*`. */
const VERBS = [
  ["GET", GET],
  ["POST", POST],
  ["PATCH", PATCH],
  ["PUT", PUT],
  ["DELETE", DELETE],
] as const;

describe("/api/auth/[...all]", () => {
  /**
   * c6: one exported handler per method. A missing verb is a silent 405 on that
   * method rather than a build failure, so it is asserted explicitly.
   */
  it("exports a handler for every method Better Auth serves", () => {
    for (const [verb, handler] of VERBS) {
      expect(typeof handler, `${verb} must be exported`).toBe("function");
    }
  });

  /**
   * D2: with no `BETTER_AUTH_SECRET`, every method answers 503
   * `auth_not_configured` instead of running with Better Auth's published default
   * signing key. Driven through the exported handler, so this is the behaviour the
   * client sees.
   *
   * `sign-in/email` is a real endpoint path, so if the catch-all stopped matching
   * the request would not reach the guard at all and this would fail rather than
   * pass vacuously.
   */
  it("answers 503 auth_not_configured on every method when no secret is set", async () => {
    delete process.env.BETTER_AUTH_SECRET;

    for (const [verb, handler] of VERBS) {
      const response = await handler(
        new Request("http://localhost:3000/api/auth/sign-in/email", {
          method: verb,
        }),
      );

      expect(response.status, `${verb} must refuse`).toBe(503);
      expect(await response.json()).toMatchObject({
        error: "auth_not_configured",
      });
    }
  });

  /**
   * The control for the assertion above: with a secret configured the guard no
   * longer refuses, so the request reaches Better Auth's own handler. What that
   * handler then answers is out of scope here — it needs a database, which the
   * db-backed suite supplies. What matters is only that the answer is NOT the
   * guard's refusal, which is precisely what "always returns 503" would fail to
   * catch.
   */
  it("stops refusing once a real secret is configured", async () => {
    process.env.BETTER_AUTH_SECRET = `test-only-${crypto.randomUUID()}${crypto.randomUUID()}`;

    const response = await POST(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
      }),
    );
    const body = await response.text();

    expect(response.status).not.toBe(503);
    expect(body).not.toContain("auth_not_configured");
  });

  /**
   * The refusal body must be safe to hand to a client: it names the variable and
   * never the value.
   */
  it("names the variable in the refusal and never the value", async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-12345678901234567890";

    const response = await POST(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("BETTER_AUTH_SECRET");
    expect(body).not.toContain("better-auth-secret-12345678901234567890");
  });

  /**
   * THE REFINEMENT QA ROUND 1 ASKED FOR (c2, the substantive finding).
   *
   * QA MEASURED over real HTTP against the built server with
   * `DEVLOOP_ALLOW_SIGN_UP` UNSET: `POST /api/auth/sign-up/email` answered
   * **200 OK**, created a user row and returned
   * `set-cookie: better-auth.session_token=…`. The flag gated only whether the
   * FORM was rendered, so the endpoint itself was open and a second account was
   * one HTTP call away — which is what c2 forbids.
   *
   * This asserts the refusal at the ENDPOINT, through the exported handler the
   * client actually calls, with a real secret configured so that the secret
   * guard cannot be what is answering. Deliberately NOT a form/HTML assertion:
   * the existing c2 form tests already pass against an ungated endpoint, which
   * is exactly why QA measured over HTTP.
   */
  it("refuses account creation at the endpoint when the flag is unset", async () => {
    process.env.BETTER_AUTH_SECRET = `test-only-${crypto.randomUUID()}${crypto.randomUUID()}`;
    delete process.env.DEVLOOP_ALLOW_SIGN_UP;

    const response = await POST(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Second Account",
          email: "second-account@example.invalid",
          password: "not-a-real-password",
        }),
      }),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({ error: "sign_up_not_allowed" });
    // The refusal must be a POLICY refusal, never a session: a body carrying a
    // token here would mean the account was created and signed in.
    expect(JSON.stringify(body)).not.toContain("token");
    // It names the VARIABLE and never any credential.
    expect(JSON.stringify(body)).toContain("DEVLOOP_ALLOW_SIGN_UP");
  });

  /**
   * THE CONTROL FOR THE ASSERTION ABOVE, and the part that makes it load-bearing.
   *
   * With the flag set to exactly `"1"`, the same endpoint must stop refusing —
   * otherwise "always returns 403" would satisfy the test above just as well as
   * a real guard would. The request then reaches Better Auth's own handler,
   * which needs a database this file deliberately does not provide; so only the
   * refusal's ABSENCE is asserted here, and the db-backed suite covers what the
   * endpoint then does.
   */
  it("stops refusing account creation once the flag is exactly 1", async () => {
    process.env.BETTER_AUTH_SECRET = `test-only-${crypto.randomUUID()}${crypto.randomUUID()}`;
    process.env.DEVLOOP_ALLOW_SIGN_UP = "1";

    const response = await POST(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Local User",
          email: "local-user@example.invalid",
          password: "not-a-real-password",
        }),
      }),
    );

    expect(response.status).not.toBe(403);
    expect(await response.text()).not.toContain("sign_up_not_allowed");
  });

  /**
   * A near-miss flag value must not open account creation. c2 says enabling it
   * has to be a DELIBERATE act, so every near-miss is off: unset, `true`, `yes`
   * and `0` all mean no. Only the exact string `"1"` is accepted.
   */
  it.each(["true", "yes", "0", "", " 1", "1 "])(
    "treats %j as NOT set, so account creation stays refused",
    async (value) => {
      process.env.BETTER_AUTH_SECRET = `test-only-${crypto.randomUUID()}${crypto.randomUUID()}`;
      process.env.DEVLOOP_ALLOW_SIGN_UP = value;

      const response = await POST(
        new Request("http://localhost:3000/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Near Miss",
            email: "near-miss@example.invalid",
            password: "not-a-real-password",
          }),
        }),
      );

      expect(response.status).toBe(403);
    },
  );

  /**
   * The flag gates ACCOUNT CREATION ONLY. Signing in must keep working with the
   * flag unset, or the deliberate flag would become a switch that turns
   * authentication itself off — which c7 forbids in the same breath as it
   * forbids an env-var bypass in production code.
   */
  it("still serves sign-in with the flag unset", async () => {
    process.env.BETTER_AUTH_SECRET = `test-only-${crypto.randomUUID()}${crypto.randomUUID()}`;
    delete process.env.DEVLOOP_ALLOW_SIGN_UP;

    const response = await POST(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "someone@example.invalid",
          password: "not-a-real-password",
        }),
      }),
    );
    const body = await response.text();

    expect(response.status).not.toBe(403);
    expect(body).not.toContain("sign_up_not_allowed");
    // Reached Better Auth, which with no database answers a credential failure
    // rather than either of DevLoop's refusals.
    expect(response.status).not.toBe(503);
  });
});
