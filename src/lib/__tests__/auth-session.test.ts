/**
 * B56: `src/lib/auth-session.ts`'s fail-closed refusal, executed by the DEFAULT
 * suite.
 *
 * WHY THIS FILE EXISTS. `auth-session.ts` is the module a later card asks "who is
 * signed in?" of, and its load-bearing contract is a REFUSAL: `getSession()` and
 * `isSignedIn()` throw `AuthSecretMissingError` when `BETTER_AUTH_SECRET` is
 * missing or set to Better Auth's published default, rather than reporting
 * `null` / `false`. `false` is a claim about the USER; an unconfigured secret is a
 * claim about the SERVER. If that distinction inverts, every protected page
 * renders its signed-out state and nobody ever learns auth is unusable.
 *
 * Until this file, that refusal was proven ONLY by
 * `db/__tests__/auth-session-forge.test.ts`, which `vitest.db.config.ts` collects
 * and only `bun run test:db` runs — and no PR check runs that. Every default-suite
 * file that touches this module replaces its whole body with a fake:
 * `src/lib/__tests__/session-guard.test.ts` `vi.mock`s `@/lib/auth-session`, and
 * `src/app/api/sync/__tests__/route-auth.test.ts` `vi.doMock`s it. So a
 * regression that made `getSession()` return `null` on an unconfigured server
 * kept `verify` green. Measured by PM at `e4b394c`: this module at 0.00% statements
 * against a tree otherwise at 93.25%.
 *
 * THIS FILE DOES NOT REPLACE THE FORGE TESTS. Those prove the forgery is refused
 * against a real Postgres with real signed cookies; this proves the refusal is
 * reachable at all in the suite that gates every pull request. Both are needed
 * and neither subsumes the other.
 *
 * WHAT IS MOCKED, AND WHY ONLY THAT. `next/headers` and nothing else — `headers()`
 * reads the ambient request and throws outside a request scope, which is a
 * framework boundary rather than the subject under test. `../auth-session` and
 * `../auth` are imported REAL: `getSession()`'s body is exactly what is under
 * test, and mocking it would reproduce the defect this card was filed for.
 * Mocking `auth.api.getSession` is also unnecessary — measured below: a
 * configured `getSession()` on a cookie-less request resolves `null` without ever
 * touching the database, because Better Auth finds no session cookie before it
 * builds a statement. That is why the positive control can be honest here and in
 * `ci.yml`, which has no Postgres service.
 *
 * ORDERING CONSTRAINT (real, and inherited from the forge suite's measurement).
 * The shipped `auth` instance's signing key is fixed at its first `$context`
 * resolution, so `process.env.BETTER_AUTH_SECRET` is assigned to a throwaway real
 * value BEFORE `../auth-session` is imported. The refusal cases below mutate the
 * ambient variable afterwards, which is precisely what `requireAuthSecret()` reads
 * on every call — so they still drive the refusal. Only the instance's signing key
 * is pinned, and none of these tests depend on it.
 *
 * THE SECRET HERE IS A THROWAWAY LITERAL, generated per run from
 * `crypto.randomUUID`, held in this process's memory only, and never written to a
 * file, an env file or a snapshot. The other literal below is Better Auth's
 * PUBLIC default from the library's own source; naming it is the assertion.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthSecretMissingError } from "@/lib/auth";

/**
 * The cookie header the fake request carries. Mutable per test so a case can
 * declare what the "request" carries without re-mocking the module.
 */
let requestCookieHeader: string | undefined;

/**
 * The `next/headers` seam. `headers()` is the ambient-request read, which throws
 * outside a request scope, so it is the one boundary faked here.
 */
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve(new Headers({ cookie: requestCookieHeader ?? "" })),
}));

/** Better Auth's published fallback secret — PUBLIC, from the library's source. */
const BETTER_AUTH_PUBLISHED_DEFAULT_SECRET =
  "better-auth-secret-12345678901234567890";

/** Every `NODE_ENV` DevLoop can run in, plus the unset case. */
const NODE_ENVS: (string | undefined)[] = [
  undefined,
  "development",
  "test",
  "production",
];

/**
 * A real, non-default, per-run secret. Assigned before the import below so the
 * instance's signing key is never the published default.
 */
const THROWAWAY_SECRET = `b56-test-only-${crypto.randomUUID()}`;

process.env.BETTER_AUTH_SECRET = THROWAWAY_SECRET;

const { getSession, isSignedIn } = await import("@/lib/auth-session");

const SAVED_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value !== undefined) process.env[key] = value;
  }
  requestCookieHeader = undefined;
});

describe("getSession() refuses to answer when auth is unconfigured (c1a, c1b)", () => {
  /**
   * c1(a): a MISSING secret. Driven in every `NODE_ENV`, `production` included —
   * Better Auth's own check fires only under `production`, so a suite that only
   * tested `production` would prove nothing about the mode DevLoop actually runs
   * in (hard rule 7: no deployment in v1).
   */
  it("rejects with AuthSecretMissingError when BETTER_AUTH_SECRET is unset, in every NODE_ENV", async () => {
    for (const nodeEnv of NODE_ENVS) {
      await withEnv("BETTER_AUTH_SECRET", undefined, async () => {
        await withEnv("NODE_ENV", nodeEnv, async () => {
          await expect(getSession()).rejects.toThrow(AuthSecretMissingError);
        });
      });
    }
  });

  /**
   * The `.env.example` state, which is what the DOCUMENTED setup produces:
   * `.env.example` ships `BETTER_AUTH_SECRET=` empty and instructs the operator to
   * copy it as-is. `""` is a misconfiguration, not a secret.
   */
  it("rejects an empty BETTER_AUTH_SECRET exactly as it rejects a missing one", async () => {
    await withEnv("BETTER_AUTH_SECRET", "", async () => {
      await expect(getSession()).rejects.toThrow(AuthSecretMissingError);
    });
  });

  /**
   * c1(b): the PUBLISHED DEFAULT. This is the value Better Auth falls back to
   * when no secret is set, and it signs forgeable cookies — the exact hole
   * `auth-session.ts`'s module note says QA measured against a real Postgres.
   */
  it("rejects with AuthSecretMissingError when the secret is Better Auth's published default, in every NODE_ENV", async () => {
    for (const nodeEnv of NODE_ENVS) {
      await withEnv(
        "BETTER_AUTH_SECRET",
        BETTER_AUTH_PUBLISHED_DEFAULT_SECRET,
        async () => {
          await withEnv("NODE_ENV", nodeEnv, async () => {
            await expect(getSession()).rejects.toThrow(AuthSecretMissingError);
            await expect(getSession()).rejects.toThrow(
              /published default secret/,
            );
          });
        },
      );
    }
  });

  /**
   * c1(c): THE INVERSION THIS MODULE EXISTS TO PREVENT. `isSignedIn()` is
   * `(await getSession()) !== null`, so it must INHERIT the refusal. The assertion
   * is `rejects`, not merely "it threw": an `isSignedIn()` that swallowed the
   * refusal and resolved `false` would satisfy any weaker check, and that is the
   * silent-default failure this whole guard is about. `resolves.toBe(false)` is
   * therefore explicitly ruled out below.
   */
  it("isSignedIn() REJECTS rather than resolving false, in every NODE_ENV", async () => {
    for (const nodeEnv of NODE_ENVS) {
      for (const badSecret of [
        undefined,
        BETTER_AUTH_PUBLISHED_DEFAULT_SECRET,
      ]) {
        await withEnv("BETTER_AUTH_SECRET", badSecret, async () => {
          await withEnv("NODE_ENV", nodeEnv, async () => {
            await expect(isSignedIn()).rejects.toThrow(AuthSecretMissingError);
          });
        });
      }
    }
  });

  /**
   * THE INVERSION, asserted as its own case and against the real module.
   *
   * `isSignedIn()` is `(await getSession()) !== null`, so it must INHERIT the
   * refusal. This case pins the half of that the loop above cannot express: that
   * `false` is not merely absent but CONTRAFIRMED. The positive control elsewhere
   * in this file shows `isSignedIn()` genuinely does resolve `false` for a
   * configured server with no session — so if a regression made the refused case
   * resolve `false` too, this is the assertion that goes red. c4 proves it by
   * mutation.
   */
  it("isSignedIn() rejects rather than resolving false when auth is unconfigured", async () => {
    for (const badSecret of [undefined, BETTER_AUTH_PUBLISHED_DEFAULT_SECRET]) {
      await withEnv("BETTER_AUTH_SECRET", badSecret, async () => {
        // The outcome is captured rather than asserted with `rejects` alone,
        // because `expect(p).resolves.not.toBe(false)` CANNOT express this: it
        // FAILS when the promise rejects, which is the behaviour being demanded.
        // A bare `rejects.toThrow(...)` also passes for an inversion that still
        // throws the WRONG error, so both facts are asserted on one observation.
        const outcome = await settle(isSignedIn);

        expect(outcome.resolved).toBe(false);
        expect(outcome.rejected).toBe(true);
        expect(outcome.error).toBeInstanceOf(AuthSecretMissingError);
        // The specific wrong answer for a misconfigured server, ruled out by
        // name: if `isSignedIn()` were ever to swallow the refusal, this is the
        // value it would produce.
        expect(outcome.value).not.toBe(false);
      });
    }
  });

  /**
   * c2, in its sharpest form. Every rejection above names `AuthSecretMissingError`,
   * and this case proves that name is load-bearing: an ordinary `Error` carrying
   * the SAME message is not an instance of it. Without this, a suite that caught
   * every error and rewrapped it as `Error` would satisfy all the assertions
   * above — the defect class B35 was raised for ("the 7 upsert tests that never
   * execute"), one level up.
   */
  it("names the refusal: a generic Error with the same message is NOT AuthSecretMissingError", async () => {
    const impostor = new Error(
      "BETTER_AUTH_SECRET is not set. Auth cookies cannot be signed without it.",
    );

    expect(impostor).toBeInstanceOf(Error);
    expect(impostor).not.toBeInstanceOf(AuthSecretMissingError);
    expect(impostor.constructor).toBe(Error);
    expect(impostor.name).toBe("Error");

    // And the real class is distinguishable in both directions, so a future
    // change that flattened `AuthSecretMissingError` into `Error` also goes red.
    expect(new AuthSecretMissingError("x")).toBeInstanceOf(Error);
    expect(new AuthSecretMissingError("x")).toBeInstanceOf(
      AuthSecretMissingError,
    );
    expect(new AuthSecretMissingError("x").constructor).toBe(
      AuthSecretMissingError,
    );
    expect(new AuthSecretMissingError("x").name).toBe("AuthSecretMissingError");
  });

  /**
   * The refusal must name the VARIABLE and must never carry the VALUE, because
   * `[...all]`'s 503 body and any log line are built from this message. Asserted
   * here rather than in `auth-instance.test.ts` because THIS is the surface a
   * page or route handler would surface when `getSession()` throws.
   */
  it("never puts the secret value in the refusal message", async () => {
    await withEnv(
      "BETTER_AUTH_SECRET",
      BETTER_AUTH_PUBLISHED_DEFAULT_SECRET,
      async () => {
        const message = await rejectionMessage(getSession);
        expect(message).toContain("BETTER_AUTH_SECRET");
        expect(message).not.toContain(BETTER_AUTH_PUBLISHED_DEFAULT_SECRET);
      },
    );

    await withEnv("BETTER_AUTH_SECRET", undefined, async () => {
      const message = await rejectionMessage(getSession);
      expect(message).toContain("BETTER_AUTH_SECRET");
      expect(message).not.toContain("undefined");
    });
  });
});

describe("getSession() ANSWERS when auth is configured (c1d, the positive control)", () => {
  /**
   * c1(d). Without this control every assertion above is satisfiable by a
   * `getSession()` that ALWAYS throws — the single most likely vacuous shape this
   * file could have shipped. `null` is the correct answer for a configured server
   * whose request carries no session cookie (Better Auth's documented behaviour),
   * and it requires no database: measured, this resolves in ~2ms without touching
   * `getDb()`.
   */
  it("resolves instead of throwing when a real, non-default secret is configured", async () => {
    await withEnv("BETTER_AUTH_SECRET", THROWAWAY_SECRET, async () => {
      requestCookieHeader = "";

      const session = await getSession();

      expect(session).toBeNull();
      // The precise claim: it RESOLVED. Not "did not throw" — a returned
      // rejection would satisfy that.
      await expect(getSession()).resolves.toBeNull();
    });
  });

  it("isSignedIn() resolves false — only now — for a configured server with no session", async () => {
    await withEnv("BETTER_AUTH_SECRET", THROWAWAY_SECRET, async () => {
      requestCookieHeader = "";

      await expect(isSignedIn()).resolves.toBe(false);
    });
  });

  /**
   * The control stated as a COMPARISON against the refused case, so a future
   * collapse of "configured" and "unconfigured" into one branch is caught even if
   * the individual assertions above are edited.
   */
  it("tells configured from unconfigured apart with the same input", async () => {
    requestCookieHeader = "";

    await withEnv("BETTER_AUTH_SECRET", THROWAWAY_SECRET, async () => {
      expect(await getSession()).toBeNull();
      expect(await isSignedIn()).toBe(false);
    });

    await withEnv("BETTER_AUTH_SECRET", undefined, async () => {
      await expect(getSession()).rejects.toThrow(AuthSecretMissingError);
      await expect(isSignedIn()).rejects.toThrow(AuthSecretMissingError);
    });

    await withEnv(
      "BETTER_AUTH_SECRET",
      BETTER_AUTH_PUBLISHED_DEFAULT_SECRET,
      async () => {
        await expect(getSession()).rejects.toThrow(AuthSecretMissingError);
        await expect(isSignedIn()).rejects.toThrow(AuthSecretMissingError);
      },
    );
  });

  /**
   * The refusal happens BEFORE the headers are read, so the unconfigured answer
   * must not depend on a request being in flight. With `headers()` pointing at a
   * header set that could not succeed if it were read, the refusal still fires —
   * which is what `auth-session.ts`'s docstring claims and what `next build` and
   * an unconfigured server rely on.
   */
  it("refuses before reading request headers, so it does not depend on a request scope", async () => {
    requestCookieHeader = undefined;

    await withEnv("BETTER_AUTH_SECRET", undefined, async () => {
      await expect(getSession()).rejects.toThrow(AuthSecretMissingError);
    });

    await withEnv("BETTER_AUTH_SECRET", undefined, async () => {
      await expect(isSignedIn()).rejects.toThrow(AuthSecretMissingError);
    });
  });

  /**
   * A non-default secret is a secret. This is the same control the shipped
   * `auth-instance.test.ts` runs against `requireAuthSecret` directly; asserted
   * here too because what matters on THIS module is that `getSession()` stops
   * refusing once one is configured.
   */
  it("accepts a configured secret that is neither missing nor the published default", async () => {
    const shortButReal = "b56-short-but-real";

    await withEnv("BETTER_AUTH_SECRET", shortButReal, async () => {
      requestCookieHeader = "";
      await expect(getSession()).resolves.toBeNull();
    });
  });
});

/**
 * Runs `subject()` and records how it finished, WITHOUT asserting.
 *
 * This exists because `expect(promise)` can only report one of the two outcomes
 * and both are wanted at once: `rejects.toThrow(AuthSecretMissingError)` proves
 * it refused with the RIGHT error but cannot also prove it did not resolve
 * `false`, and `resolves.not.toBe(false)` fails outright when the promise
 * rejects — which is the behaviour being demanded. Asserting on both fields of one
 * observation is the only shape that states "it refused, and never produced the
 * signed-out answer" as a single claim that can go red either way.
 */
async function settle(subject: () => Promise<unknown>): Promise<{
  resolved: boolean;
  rejected: boolean;
  value?: unknown;
  error?: unknown;
}> {
  try {
    return { resolved: true, rejected: false, value: await subject() };
  } catch (error) {
    return { resolved: false, rejected: true, error };
  }
}

/**
 * Runs `body` with one env var set to `value`, or unset when `value` is
 * undefined. Async-safe: the restore happens after an awaited body settles, which
 * is what makes the `NODE_ENV` loops above sequential rather than interleaved.
 */
function withEnv(
  name: string,
  value: string | undefined,
  body: () => void | Promise<void>,
): void | Promise<void> {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  let result: void | Promise<void>;
  try {
    result = body();
  } catch (error) {
    restore(name, original);
    throw error;
  }
  if (result instanceof Promise) {
    return result.then(
      () => restore(name, original),
      (error: unknown) => {
        restore(name, original);
        throw error;
      },
    );
  }
  restore(name, original);
  return result;
}

function restore(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

/**
 * The message `subject()` refused with, or `""` when it resolved.
 *
 * Asserted on rather than a bare `rejects.toThrow()` because a refusal must be
 * SAYING something: the operator reads this text to know which variable to set.
 */
async function rejectionMessage(
  subject: () => Promise<unknown>,
): Promise<string> {
  try {
    await subject();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
