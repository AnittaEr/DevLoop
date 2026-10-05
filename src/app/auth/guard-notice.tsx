/**
 * The one place the session guard's three outcomes are rendered (T20).
 *
 * WHY THIS IS A COMPONENT AND NOT A PER-PAGE BRANCH. `requireSession()` in
 * `src/lib/session-guard.ts` (B46) returns three outcomes, and the page that
 * consumes it must not be able to get one of them wrong. `auth_not_configured`
 * in particular is the outcome that is dangerous to lose: rendering it as "you
 * are signed out" is exactly the silent-default failure D2 and D5 exist to
 * prevent, because it makes a broken `.env` indistinguishable from a normal
 * visitor forever. So the three outcomes are mapped to three visually distinct,
 * textually named answers here, once.
 *
 * WHAT IS NOT HERE. No redirect, no status code, no `fetch`. This module only
 * turns a refusal into words. Which status a page answers with, and whether it
 * redirects, is the page's decision.
 *
 * NO SECRET IS EVER RENDERED. The guard's message names the VARIABLE
 * (`BETTER_AUTH_SECRET`) and never its value — that is the guard's own
 * contract, asserted in `src/lib/__tests__/session-guard.test.ts` — and
 * nothing here reads `process.env` at all.
 */

import type { SessionRefusalBody } from "@/lib/session-guard";
import { SESSION_GUARD_OUTCOMES } from "@/lib/session-guard";

/**
 * Render a refusal body as a loud, named panel.
 *
 * `tone` is chosen by the CALLER from the outcome, never inferred here, so a
 * page cannot pass "signed out" styling for a misconfiguration by accident:
 * the two are given different roles and the notice says which is which in
 * words as well as colour.
 */
export function GuardNotice({
  refusal,
  title,
}: {
  readonly refusal: SessionRefusalBody;
  readonly title: string;
}) {
  const isMisconfigured =
    refusal.outcome === SESSION_GUARD_OUTCOMES.authNotConfigured;

  return (
    <section
      // `role="alert"` so a screen reader announces it: this is the failure
      // state a developer hits when their `.env` is wrong, and it is the only
      // signal they get.
      role="alert"
      data-testid="guard-notice"
      data-outcome={refusal.outcome}
      className={
        isMisconfigured
          ? "flex flex-col gap-2 rounded-lg border border-red-500 bg-red-50 p-6 text-red-900 dark:bg-red-950 dark:text-red-100"
          : "flex flex-col gap-2 rounded-lg border border-amber-500 bg-amber-50 p-6 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
      }
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm">
        {isMisconfigured
          ? "AUTH IS NOT CONFIGURED — this is a server-side configuration fault, " +
            "not a signed-out visitor. Nothing below is shown because DevLoop " +
            "cannot tell who anyone is yet."
          : "NO SESSION — you are not signed in."}
      </p>
      <p className="font-mono text-sm">{refusal.message}</p>
      <p className="text-xs">
        Condition: <code>{refusal.outcome}</code>
      </p>
    </section>
  );
}
