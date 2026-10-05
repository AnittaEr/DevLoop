import { defineConfig, devices } from "@playwright/test";

/**
 * WHY THIS IS `localhost` AND NOT `127.0.0.1`. MEASURED, and it is the reason
 * the authenticated half of T20's e2e spec could not sign in at all.
 *
 * Better Auth's CSRF guard compares the request's `Origin` header against its
 * trusted origins, and with a static `baseURL` that list contains exactly ONE
 * entry: the origin derived from `baseURL` (`getTrustedOrigins`,
 * `dist/context/helpers.mjs`). `src/lib/auth.ts` defaults that to
 * `http://localhost:3000`. So a browser reaching the server at
 * `http://127.0.0.1:3000` sends `Origin: http://127.0.0.1:3000`, which is not the
 * trusted origin, and Better Auth answers **403 Forbidden** with
 * `ERROR [Better Auth]: Invalid origin: http://127.0.0.1:3000` — before any
 * credential is checked. A direct `curl` to `localhost` succeeded against the
 * same build and database, which is what pinned the fault to the origin rather
 * than to the credential, the cookie, the guard or the page.
 *
 * The two hosts are interchangeable for a human at a keyboard, so this reads as
 * a harness quirk rather than a defect. It is not one to fix by disabling the
 * origin check — that would remove a real CSRF protection from production code
 * to suit a test, which c7 forbids in the same breath as it forbids an
 * auth-disabling env var. The two legitimate fixes are to trust both origins
 * (T19's `src/lib/auth.ts`, DO NOT TOUCH on this card) or to have the harness
 * use the origin the app is configured for. This is the second.
 *
 * `webServer.url` must change with it, or Playwright would poll one origin
 * while the tests drive another.
 */
const HOST = "localhost";
const PORT = 3000;
const baseURL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Specs live outside src/, so Vitest's `src/**/*.test.*` include can never
  // pick them up. This glob keeps `playwright test` away from src/ unit tests.
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // ZERO RETRIES — DELIBERATE, AND NOT A "TEMPORARY MEASURE".
  //
  // THIS WAS `retries: process.env.CI ? 2 : 0`, and it made the `e2e` CI check
  // structurally incapable of going red for the class of defect e2e specs are
  // most often written to catch. Measured on `origin/main` (`1f4bd5c`): a spec
  // whose assertion holds only from attempt 2 onward was reported `1 flaky`,
  // printed its failure, and Playwright exited 0. The `e2e` job in
  // `.github/workflows/ci.yml` exists precisely so that "when it goes red the PR
  // checks list says e2e failed"; with two retries a real defect that happened
  // to be order- or timing-sensitive converted that red into a green. `1 flaky`
  // + exit 0 is the same self-certifying-green shape this repository has closed
  // five times, and it lived in the one check whose badge is the headline
  // claim. `forbidOnly` above already guards `test.only`; nothing guarded this.
  //
  // THE TRADE-OFF I AM MAKING, STATED ONCE SO IT IS NOT REDISCOVERED LATER:
  // a flake is now a RED BUILD, not a self-healing one. That is the point — a
  // retry that hides a first-attempt failure is indistinguishable from a test
  // that never fails, and it trains every future reader of the checks list to
  // discount the `e2e` badge. The residual is real and must not be talked away:
  // a genuinely timing-flaky spec — one that is correct but order-sensitive —
  // will now fail the run instead of healing on attempt 2 or 3, and the fix
  // belongs in the cause (wait for the state you actually depend on, scope the
  // fixture, stop sharing mutable state across specs), never in raising this
  // number. If you are reading this because a spec just went red for the second
  // time in a month, the answer is to diagnose that spec, not to reintroduce
  // retries: this value is policed by `src/__tests__/playwright-retries.test.ts`,
  // which reads this file as text and fails if `retries` can ever resolve to a
  // non-zero value under CI — so raising it here turns the `verify` job red on
  // the very commit that tries to hide an e2e failure. That is intended.
  retries: 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL,
    // Headless-by-default behaviour is identical locally and in CI (the
    // chromium project uses the bundled Chrome channel-less build, headless
    // unless `--headed` is passed). CI/telemetry flags are pinned in
    // webServer.env below; Playwright's typed `use` block rejects a `CI` key.
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Playwright does not forward the whole shell env to the server unless
      // asked; set these explicitly so the build never reaches out.
      NEXT_TELEMETRY_DISABLED: "1",
      CI: process.env.CI ?? "",
    },
  },
});
