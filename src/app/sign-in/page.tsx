/**
 * `/sign-in` — the redirect target for the evidence page's refusal (T20).
 *
 * WHY THIS PAGE CALLS `requireSession()` EVEN THOUGH IT RENDERS NO EVIDENCE.
 * Two reasons, and the second is the important one. The first is c1: a visitor
 * who is ALREADY signed in has no business seeing a sign-in form, so this page
 * sends them onward. The second is that this is the page a guard refuses TO,
 * which means it is the page where "auth is not configured" has to be visible:
 * if the guard answered `auth_not_configured` here, a developer whose `.env` is
 * wrong would see a sign-in form they cannot possibly satisfy, with no
 * indication that the real fault is the missing `BETTER_AUTH_SECRET`. So the
 * third outcome is rendered as a loud configuration error and never as a form.
 *
 * IT CALLS THE ONE SEAM. `requireSession()` from `src/lib/session-guard.ts` (B46)
 * — never `getSession()`, never `auth.api.getSession`, never a cookie read.
 * `getSession()` is not exported for pages to call directly precisely so that
 * every call site goes through the guard that distinguishes the three outcomes;
 * calling it here would re-introduce the misconfiguration-as-signed-out bug on
 * the one page where the operator is most likely to be looking at it.
 *
 * WHY IT IS DYNAMIC. Its entire output depends on live cookie state, and a
 * cached 200 would be a lie about who is signed in — the same reasoning
 * `src/app/api/sync/route.ts` records.
 */

import { redirect } from "next/navigation";

import { AuthForm } from "@/app/auth/auth-form";
import { GuardNotice } from "@/app/auth/guard-notice";
import { signUpAllowed } from "@/app/auth/sign-up-flag";
import { SIGNED_IN_DESTINATION } from "@/app/evidence/destination";
import { SESSION_GUARD_OUTCOMES, requireSession } from "@/lib/session-guard";

// `dynamic` is the ONLY export from this module besides the default component.
// MEASURED, twice: Next.js validates a `page.tsx` module's exports against its
// generated types and rejects any other name, so this file once failed
// `next build` with `"ALLOW_SIGN_UP_ENV_VAR" is not a valid Page export field`
// and then, after moving that constant, with the same error for
// `SIGNED_IN_DESTINATION`. Both now live in `src/app/auth/sign-up-flag.ts` and
// `src/app/evidence/destination.ts`; a test imports them from there rather than
// from this page. Re-exporting a constant for a test's convenience is not
// worth a route that will not build.
export const dynamic = "force-dynamic";

export default async function SignInPage() {
  const guard = await requireSession();

  if (guard.ok === false) {
    // The misconfiguration is NOT caught into a redirect and NOT rendered as the
    // signed-out state. It gets its own named panel, on this page, where the
    // operator is looking for a form that will not work.
    if (guard.outcome === SESSION_GUARD_OUTCOMES.authNotConfigured) {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
          <GuardNotice
            refusal={guard.body}
            title="Sign-in is not available: auth is not configured"
          />
        </main>
      );
    }

    // An ordinary signed-out visitor: this is the one page a refusal SHOULD
    // render rather than redirect away from, because arriving here signed out is
    // the expected way to use it.
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
        <h1 className="text-3xl font-bold tracking-tight">Sign in</h1>
        <AuthForm allowSignUp={signUpAllowed()} />
      </main>
    );
  }

  // Already signed in: send them to the protected page rather than showing a
  // form whose only effect would be to overwrite a working session.
  redirect(SIGNED_IN_DESTINATION);
}
