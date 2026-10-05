"use client";

/**
 * Sign-out control for the protected evidence page (T20).
 *
 * WHY IT IS HERE AND NOT ONLY ON `/sign-in`. `/sign-in` redirects an
 * already-signed-in visitor to `/evidence` (c1), so a signed-in user cannot
 * reach the sign-in page to sign out of it — leaving the sign-out button there
 * would be a control that is unreachable exactly when it is needed. The
 * protected page is the page a signed-in user is actually on, so the control
 * belongs here.
 *
 * IT CALLS THE LIBRARY, NOT THE DATABASE. `authClient.signOut()` goes to the
 * mounted `/api/auth/sign-out` endpoint; this island revokes nothing itself and
 * writes no cookie. Revoking a session is the library's job for the same reason
 * verifying a password is: doing it locally means implementing the session
 * store's own notion of "this token is no longer valid", and getting that wrong
 * fails either open (the token keeps working) or closed (every sign-in breaks).
 *
 * AFTER SIGN-OUT IT NAVIGATES TO `/sign-in` RATHER THAN TO `/evidence`. Going
 * straight back to `/evidence` would be answered by the guard's redirect anyway,
 * so it works — but landing on the sign-in form is the honest end state and it
 * is one round trip instead of two.
 *
 * NO TOKEN IS READ, STORED OR RENDERED. The session lives in an HTTP-only
 * cookie this code cannot see; the JSON response is checked for an error and
 * otherwise discarded.
 */

import { useState } from "react";
import { createAuthClient } from "better-auth/client";

import { Button } from "@/components/ui/button";
import { SIGN_IN_ROUTE } from "@/app/evidence/destination";

const authClient = createAuthClient();

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        data-testid="sign-out"
        onClick={() => {
          setBusy(true);
          setMessage(null);
          void (async () => {
            try {
              const result = await authClient.signOut();
              if (result.error) {
                // Fixed text: the library's error is not rendered, because a
                // failure here says nothing the visitor can act on beyond
                // "try again" and its body can echo request detail.
                setMessage("Sign-out failed. Try again.");
                setBusy(false);
                return;
              }
              window.location.assign(SIGN_IN_ROUTE);
            } catch {
              setMessage("Sign-out failed. Try again.");
              setBusy(false);
            }
          })();
        }}
      >
        Sign out
      </Button>
      {message !== null ? (
        <p
          role="alert"
          data-testid="sign-out-message"
          className="text-sm text-red-700"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
