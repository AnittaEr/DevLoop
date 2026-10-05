/**
 * T19 (a) and the round-1 review fixes D2/D3: the shipped auth instance, its
 * configuration, and DevLoop's own fail-closed secret handling.
 *
 * RUNS WITH NO DATABASE AND NO `.env`. This is the offline half of T19: it
 * asserts the configuration the rest of the plumbing depends on, and the
 * fail-closed secret behaviour. It is in `bun run test`, NOT in `bun run test:db`,
 * because it needs no Postgres and must stay runnable in CI (which has no
 * database service — see `vitest.db.config.ts`'s header).
 *
 * THE SECRET HERE IS A THROWAWAY LITERAL. It is generated per run from
 * `crypto.randomUUID`, exists only in this process's memory, and is never
 * written to a file, an env file or a snapshot. The card forbids pasting a real
 * secret into a test; this is the opposite of that — it is the absence of one,
 * asserted below.
 *
 * WHY THESE TESTS NOW IMPORT THE SHIPPED `auth` INSTANCE. Round 1 review (D3)
 * removed `baseURL` and the whole `emailAndPassword` block from the module-scope
 * instance and every gate stayed green, because this suite hand-rolled its own
 * `betterAuth({...})` — a lookalike of the options DevLoop ships. The assertions
 * below therefore read `auth.options`, the object `toNextJsHandler(auth.handler)`
 * actually mounts, and `authAdapterConfig()`, the config the shipped adapter is
 * built from. Importing `src/lib/auth` is safe here with no database and no
 * `.env`: the Drizzle client is a proxy that resolves `getDb()` on first
 * property access, and the secret refusal is request-time only.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AUTH_SCHEMA,
  AuthSecretMissingError,
  DEFAULT_BASE_URL,
  auth,
  authAdapterConfig,
  authBaseOptions,
  readAuthSecret,
  requireAuthSecret,
} from "../auth";

/** A throwaway secret, never persisted anywhere. */
const THROWAWAY_SECRET = `test-only-${randomUUID()}${randomUUID()}`;

/**
 * The literal Better Auth falls back to when no secret is set. It is a PUBLIC
 * string from the library's own source, so naming it here asserts the opposite of
 * the card's "no secret literal in a test" rule — which is the point: DevLoop must
 * refuse exactly this value.
 */
const BETTER_AUTH_PUBLISHED_DEFAULT_SECRET =
  "better-auth-secret-12345678901234567890";

describe("the shipped auth instance (D3)", () => {
  it("is constructed with a working handler", () => {
    expect(auth).toBeDefined();
    expect(typeof auth.handler).toBe("function");
  });

  /**
   * The assertion QA's D3 probe showed could not fail. Deleting `baseURL` or the
   * whole `emailAndPassword` block from the shipped instance left all six gates
   * green; now each of these reads the shipped instance's own resolved options, so
   * removing an option turns this test red.
   */
  it("enables email and password on the instance the route mounts", () => {
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
  });

  it("resolves the default base URL on the shipped instance", () => {
    expect(DEFAULT_BASE_URL).toBe("http://localhost:3000");
    expect(auth.options.baseURL).toBe(DEFAULT_BASE_URL);
  });

  it("keeps telemetry off so a local-only app cannot phone home", () => {
    expect(auth.options.telemetry?.enabled).toBe(false);
  });

  /**
   * `appName` appears in Better Auth's own error copy, so a wrong one is
   * user-visible rather than cosmetic.
   */
  it("names the app", () => {
    expect(auth.options.appName).toBe("DevLoop");
  });

  /**
   * The control for the assertions above, in the same shape: a lookalike options
   * object with those options removed must NOT satisfy them. Without this,
   * `toBe(true)` / `toBe(DEFAULT_BASE_URL)` could be satisfied by fields Better
   * Auth defaults or never populates — assertions that cannot fail.
   */
  it("a stripped lookalike fails the assertions above", () => {
    const stripped = {
      appName: "DevLoop",
      telemetry: { enabled: false },
    } as Record<string, { enabled?: boolean } | undefined>;

    expect(stripped.emailAndPassword?.enabled).toBeUndefined();
    expect(stripped.baseURL).toBeUndefined();
    expect(auth.options.emailAndPassword?.enabled).not.toBe(
      stripped.emailAndPassword?.enabled,
    );
    expect(auth.options.baseURL).not.toBe(stripped.baseURL);
  });

  it("defaults BETTER_AUTH_URL to the local dev origin when unset", () => {
    withEnv("BETTER_AUTH_URL", undefined, () => {
      expect(authBaseOptions().baseURL).toBe("http://localhost:3000");
    });
  });

  it("honours BETTER_AUTH_URL when it is set", () => {
    withEnv("BETTER_AUTH_URL", "http://127.0.0.1:4321", () => {
      expect(authBaseOptions().baseURL).toBe("http://127.0.0.1:4321");
    });
  });

  it("points the shipped adapter at all four auth tables on pg", () => {
    const config = authAdapterConfig();

    expect(config.provider).toBe("pg");
    // Spelled out rather than `Object.keys` alone: the adapter looks each table
    // up by exactly this key (`getSchema(model)`) and throws if one is renamed.
    expect(Object.keys(config.schema ?? {}).sort()).toEqual([
      "account",
      "session",
      "user",
      "verification",
    ]);
    expect(AUTH_SCHEMA.user).toBe(config.schema?.user);
  });
});

describe("secret handling (D2)", () => {
  /**
   * c2: the secret is read from the environment and never defaulted. With no
   * value set, `readAuthSecret` must report none and `requireAuthSecret` must
   * refuse — DevLoop must never invent one.
   */
  it("reports no secret when the environment has none, and refuses to run", () => {
    withEnv("BETTER_AUTH_SECRET", undefined, () => {
      expect(readAuthSecret()).toBeUndefined();
      expect(() => requireAuthSecret()).toThrow(AuthSecretMissingError);
    });
  });

  it("treats an empty secret as no secret", () => {
    withEnv("BETTER_AUTH_SECRET", "", () => {
      expect(() => requireAuthSecret()).toThrow(AuthSecretMissingError);
    });
  });

  /**
   * The defect QA measured (D2): with no secret configured, the shipped instance
   * resolved `secret = "better-auth-secret-12345678901234567890"` — the literal
   * published in Better Auth's own source — and only `NODE_ENV=production`
   * rejected it, a mode v1 never runs in (no deployment, hard rule 7). DevLoop now
   * refuses it in every mode.
   */
  it("refuses Better Auth's published default secret in any NODE_ENV", () => {
    for (const nodeEnv of ["development", "test", "production", undefined]) {
      withEnv(
        "BETTER_AUTH_SECRET",
        BETTER_AUTH_PUBLISHED_DEFAULT_SECRET,
        () => {
          withEnv("NODE_ENV", nodeEnv, () => {
            expect(() => requireAuthSecret()).toThrow(AuthSecretMissingError);
            expect(() => requireAuthSecret()).toThrow(
              /published default secret/,
            );
          });
        },
      );
    }
  });

  /**
   * The message is returned to the client by the `[...all]` route, so it must name
   * the VARIABLE and must never contain the value — including when the refusal is
   * about a value that IS set.
   */
  it("never puts the secret value in the refusal message", () => {
    withEnv("BETTER_AUTH_SECRET", BETTER_AUTH_PUBLISHED_DEFAULT_SECRET, () => {
      const message = refusalMessage();
      expect(message).toContain("BETTER_AUTH_SECRET");
      expect(message).not.toContain(BETTER_AUTH_PUBLISHED_DEFAULT_SECRET);
    });

    withEnv("BETTER_AUTH_SECRET", undefined, () => {
      const message = refusalMessage();
      expect(message).toContain("BETTER_AUTH_SECRET");
      expect(message).not.toContain("undefined");
    });
  });

  /**
   * The control for every refusal above, in the same shape: a real configured
   * secret must pass. Without it, "always throws" would satisfy all of them.
   */
  it("accepts a real configured secret and returns exactly that value", () => {
    withEnv("BETTER_AUTH_SECRET", THROWAWAY_SECRET, () => {
      expect(readAuthSecret()).toBe(THROWAWAY_SECRET);
      expect(requireAuthSecret()).toBe(THROWAWAY_SECRET);
    });
  });

  /**
   * Length validation belongs to Better Auth, the only party that can see how the
   * value is used. DevLoop refuses only what is unambiguously wrong, so a short
   * non-default secret is not blocked here.
   */
  it("does not duplicate the library's length validation", () => {
    withEnv("BETTER_AUTH_SECRET", "short", () => {
      expect(requireAuthSecret()).toBe("short");
    });
  });
});

/** The message `requireAuthSecret` refuses with, or "" if it did not refuse. */
function refusalMessage(): string {
  try {
    requireAuthSecret();
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

/** Runs `body` with one env var set to `value`, or unset when `value` is undefined. */
function withEnv(
  name: string,
  value: string | undefined,
  body: () => void,
): void {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    body();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}
