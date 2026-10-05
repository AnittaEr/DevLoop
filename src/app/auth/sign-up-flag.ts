/**
 * Whether account CREATION is offered (T20).
 *
 * WHY IT IS NOT EXPORTED FROM THE PAGE. Next.js validates a `page.tsx`
 * module's exports against its generated types and rejects anything that is not
 * a page component or a route-segment config — MEASURED: exporting
 * `ALLOW_SIGN_UP_ENV_VAR` from `src/app/sign-in/page.tsx` fails `next build`
 * with `"ALLOW_SIGN_UP_ENV_VAR" is not a valid Page export field`. So the
 * constant lives here and the page imports it, which is also what lets the
 * tests name the variable without importing the page module.
 *
 * WHAT IT GATES, PRECISELY: account CREATION, and nothing else. It is not an
 * authentication switch and there is no flag anywhere that disables the session
 * guard — c7 forbids one and this card ships none. Unset, `false`, `true`,
 * `yes` and a whitespace-padded value all mean OFF; only the exact string `"1"`
 * turns sign-up on, so enabling second accounts is always a deliberate act.
 *
 * This module reads no value beyond its own comparison, holds no credential and
 * is imported by nothing outside the sign-in page and its tests.
 */

/** The environment variable that offers account CREATION. Name only. */
export const ALLOW_SIGN_UP_ENV_VAR = "DEVLOOP_ALLOW_SIGN_UP";

/**
 * True only for the exact string `"1"`.
 *
 * Compared by equality against one value rather than tested for truthiness, so
 * there is no string a developer could set by accident and get a second
 * account. `.env.example`'s convention of shipping an EMPTY value as "fill
 * this in" is respected for free: empty is not `"1"`, so it means off.
 */
export function signUpAllowed(): boolean {
  return process.env[ALLOW_SIGN_UP_ENV_VAR] === "1";
}
