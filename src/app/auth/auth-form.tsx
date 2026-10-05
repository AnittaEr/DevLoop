"use client";

/**
 * The sign-in / sign-up form (T20).
 *
 * EVERY CREDENTIAL OPERATION BELOW GOES THROUGH `better-auth/client`. This
 * island never hashes a password, never compares one, never writes a cookie and
 * never constructs a session token. It calls `authClient.signIn.email(...)` or
 * `authClient.signUp.email(...)`, which `fetch` the mounted `/api/auth/*`
 * endpoints, and Better Auth does credential checking, hashing and cookie
 * writing. Duplicating any of that is how auth gets subtly wrong — a second
 * implementation is a second opinion about what a valid credential is, and it is
 * the one that will not be kept in step with the library's session format.
 *
 * WHY A CLIENT ISLAND AND NOT A SERVER ACTION. A server action would have to
 * accept a password and forward it, which means choosing a place for it to live
 * in the process; the browser posting it straight to the endpoint the library
 * already exposes keeps the password inside Better Auth's own request handling
 * with no DevLoop code holding it at all.
 *
 * WHY SIGN-UP IS OFF BY DEFAULT AND BEHIND AN EXPLICIT FLAG (c2). DevLoop is a
 * single-user LOCAL app (D2: no hosted database, no deployment), so it needs a
 * way to create the first account and no reason to allow a second one. So the
 * form only offers sign-up when `allowSignUp` is true, and the page turns that
 * on only when `DEVLOOP_ALLOW_SIGN_UP` is set to `"1"` — never defaulted on, and
 * never a boolean that merely happens to be truthy, so `DEVLOOP_ALLOW_SIGN_UP=false`
 * and an unset variable both mean "off". A deployed instance therefore cannot
 * grow a second account unless somebody deliberately sets that variable.
 *
 * THE FLAG IS NOT AN AUTHENTICATION SWITCH. It gates account CREATION only. No
 * flag anywhere disables the session guard or lets a request through
 * unauthenticated — c7 forbids that and this file complies.
 *
 * NO SECRET, PASSWORD OR TOKEN IS EVER STORED OR DISPLAYED. The email and
 * password live in React state for as long as the form is mounted and are sent
 * in the request body; the session token that Better Auth returns in its JSON is
 * discarded here and never rendered, stored, or logged. The only thing kept
 * after a successful call is the boolean "we are now navigating".
 */

import { useState } from "react";
import { createAuthClient } from "better-auth/client";

import { Button } from "@/components/ui/button";

/**
 * The browser-side auth client.
 *
 * `createAuthClient` with no `baseURL` resolves to the library's own default of
 * `/api/auth`, which is exactly where T19 mounted the `[...all]` catch-all. It
 * is created ONCE at module scope so two components cannot end up with two
 * clients and two independent views of the session; `baseURL` is deliberately
 * not passed, so the base comes from the mounted route rather than from an
 * environment variable that could point it somewhere else.
 */
const authClient = createAuthClient();

/** Fixed copy. Never contains a credential, a token or an error's raw body. */
const SIGN_IN_FAILED =
  "Sign-in failed. Check the email and password and try again.";

const SIGN_UP_FAILED =
  "Sign-up failed. That address may already be registered, or the password " +
  "may be shorter than the minimum.";

const SIGN_OUT_FAILED = "Sign-out failed. Try again.";

export function AuthForm({ allowSignUp }: { readonly allowSignUp: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Shared submit path for sign-in and sign-up.
   *
   * The two are behind one handler rather than duplicated because they differ
   * only in which client call they make — and the differing part is exactly the
   * part that must not drift, so it is the one part that is written out in full
   * at each call site.
   */
  async function submit(action: "sign-in" | "sign-up"): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const result =
        action === "sign-in"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name });

      if (result.error) {
        // The library's own error is NOT rendered. Its message can echo back
        // submitted values, and the caller has learned everything actionable
        // from the fixed text above — which names the possible causes without
        // reporting a password or an internal detail to the page.
        setMessage(action === "sign-in" ? SIGN_IN_FAILED : SIGN_UP_FAILED);
        setBusy(false);
        return;
      }

      // A full navigation, not a client-side push. The session was just written
      // as an HTTP-only cookie by the library, and the destination page is
      // server-rendered and guards itself — so the browser must ask the SERVER
      // for it rather than rendering it locally from a cached bundle.
      window.location.assign("/evidence");
    } catch {
      setMessage(action === "sign-in" ? SIGN_IN_FAILED : SIGN_UP_FAILED);
      setBusy(false);
    }
  }

  async function signOut(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setMessage(SIGN_OUT_FAILED);
        setBusy(false);
        return;
      }
      // Back to the sign-in page. The server decides whether a session remains;
      // this island only asks it.
      window.location.assign("/sign-in");
    } catch {
      setMessage(SIGN_OUT_FAILED);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          // `preventDefault` so this is a client call and not a native form POST
          // that would put the password in the URL bar and in the server's
          // request log.
          event.preventDefault();
          void submit("sign-in");
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="border-input rounded-md border px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="border-input rounded-md border px-3 py-2"
          />
        </label>

        <Button type="submit" disabled={busy}>
          Sign in
        </Button>
      </form>

      {allowSignUp ? (
        <form
          className="border-input flex flex-col gap-4 border-t pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit("sign-up");
          }}
        >
          <p className="text-sm font-semibold">Create the local account</p>
          <p className="text-xs text-muted-foreground">
            DevLoop is single-user and local. This form is shown only because{" "}
            <code>DEVLOOP_ALLOW_SIGN_UP=1</code> is set; unset or{" "}
            <code>false</code>, account creation is not offered at all.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input
              type="text"
              name="name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="border-input rounded-md border px-3 py-2"
            />
          </label>
          <Button type="submit" disabled={busy} variant="secondary">
            Sign up
          </Button>
        </form>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          void signOut();
        }}
      >
        Sign out
      </Button>

      {message !== null ? (
        <p
          role="alert"
          data-testid="auth-message"
          className="text-sm text-red-700"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
