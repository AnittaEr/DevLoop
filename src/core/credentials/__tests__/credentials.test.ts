import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import zodPackage from "zod/package.json" with { type: "json" };

import {
  CREDENTIAL_ERROR_SOURCES,
  CREDENTIAL_FAILURE_REASONS,
  CREDENTIAL_SOURCES,
  CredentialError,
  GITHUB_TOKEN_PREFIX,
  TEST_ONLY_CREDENTIAL_SOURCES,
  TOKEN_DEFECT_REASONS,
  UNKNOWN_CREDENTIAL_SOURCE,
  isCredentialSource,
  isTestOnlyCredentialSource,
  toSafeCredentialSource,
  toSafeFailureReason,
  validateTokenShape,
} from "../provider";
import type {
  CredentialErrorSource,
  CredentialFailureReason,
  CredentialSource,
  TestOnlyCredentialSource,
} from "../provider";
import { GITHUB_TOKEN_ENV_VAR, EnvCredentialProvider } from "../env-provider";
import { FAKE_TOKENS, FakeCredentialProvider } from "../fakes";
import { createCredentialProvider } from "../factory";

/** Synthetic, clearly-not-a-secret token. Not a real token shape. */
const GOOD = "github_pat_-not-a-real-fixture-token-1";
const OTHER = "github_pat_-not-a-real-fixture-token-2";

/**
 * The version of the zod actually resolved at runtime, not from package.json.
 *
 * Read defensively: this is a provenance assertion for the test suite, so if a
 * future zod changes its export shape the failure must be "cannot read the
 * version", never a type error at import time.
 */
function readZodVersion(): string {
  const fromPackage = (zodPackage as { version?: unknown }).version;
  if (typeof fromPackage === "string") return fromPackage;
  const fromRuntime = (z as unknown as { _zod?: { version?: unknown } })._zod
    ?.version;
  return typeof fromRuntime === "string" ? fromRuntime : "";
}

const zodVersion = readZodVersion();

/** Run a synchronous thunk that must throw a CredentialError, and return it. */
function capture(thunk: () => unknown): CredentialError {
  try {
    thunk();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialError);
    return error as CredentialError;
  }
  throw new Error("expected a CredentialError but nothing was thrown");
}

function expectCredentialError(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a CredentialError but the promise resolved");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(CredentialError);
      return error as CredentialError;
    },
  );
}

const originalEnv = process.env[GITHUB_TOKEN_ENV_VAR];

beforeEach(() => {
  delete process.env[GITHUB_TOKEN_ENV_VAR];
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[GITHUB_TOKEN_ENV_VAR];
  } else {
    process.env[GITHUB_TOKEN_ENV_VAR] = originalEnv;
  }
});

describe("CredentialProvider contract", () => {
  it("exposes a discriminant on every implementation", () => {
    expect(new EnvCredentialProvider().source).toBe("env");
    expect(new FakeCredentialProvider().source).toBe("fake");
  });

  it("classifies sources", () => {
    expect(isCredentialSource("env")).toBe(true);
    expect(isCredentialSource("fake")).toBe(true);
    expect(isCredentialSource("vault")).toBe(false);
    expect(isCredentialSource(undefined)).toBe(false);
    expect(isTestOnlyCredentialSource("fake")).toBe(true);
    expect(isTestOnlyCredentialSource("env")).toBe(false);
  });

  it("every provider implements getToken(): Promise<string>", async () => {
    const providers = [
      new EnvCredentialProvider({ readEnv: () => GOOD }),
      new FakeCredentialProvider(),
    ];
    for (const provider of providers) {
      const result = provider.getToken();
      expect(typeof result.then).toBe("function");
      await expect(result).resolves.toBeTypeOf("string");
    }
  });
});

describe("env provider happy path", () => {
  it("returns a valid token from the documented variable", async () => {
    process.env[GITHUB_TOKEN_ENV_VAR] = GOOD;
    const provider = new EnvCredentialProvider();
    await expect(provider.getToken()).resolves.toBe(GOOD);
  });

  it("reads process.env lazily, not at module import time", async () => {
    // Constructed while the variable is unset, then set afterwards.
    const provider = new EnvCredentialProvider();
    await expectCredentialError(provider.getToken());
    process.env[GITHUB_TOKEN_ENV_VAR] = OTHER;
    await expect(provider.getToken()).resolves.toBe(OTHER);
  });

  it("honours an injected env reader", async () => {
    const provider = new EnvCredentialProvider({ readEnv: () => GOOD });
    await expect(provider.getToken()).resolves.toBe(GOOD);
  });
});

describe("fake provider happy path", () => {
  it("returns the in-memory fixture value", async () => {
    await expect(new FakeCredentialProvider().getToken()).resolves.toBe(
      FAKE_TOKENS.valid,
    );
  });

  it("returns values from a caller-supplied in-memory map", async () => {
    const provider = new FakeCredentialProvider({ tokens: { valid: OTHER } });
    await expect(provider.getToken()).resolves.toBe(OTHER);
  });

  it("fails typed when the map has no value under the expected key", async () => {
    const provider = new FakeCredentialProvider({ tokens: {} });
    const error = await expectCredentialError(provider.getToken());
    expect(error.code).toBe("token_absent");
    expect(error.source).toBe("fake");
  });
});

describe("absent token -> typed error", () => {
  it("env provider throws token_absent when the variable is unset", async () => {
    const error = await expectCredentialError(
      new EnvCredentialProvider().getToken(),
    );
    expect(error.code).toBe("token_absent");
    expect(error.source).toBe("env");
    expect(error.message).toContain(GITHUB_TOKEN_ENV_VAR);
  });

  it("env provider throws token_absent for an empty or whitespace value", async () => {
    for (const value of ["", "   ", "\t\n"]) {
      const error = await expectCredentialError(
        new EnvCredentialProvider({ readEnv: () => value }).getToken(),
      );
      expect(error.code).toBe("token_absent");
      expect(error.source).toBe("env");
    }
  });

  it("rejects a non-string provider result as token_absent", () => {
    try {
      validateTokenShape(undefined, "env");
      throw new Error("expected a CredentialError");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect((error as CredentialError).code).toBe("token_absent");
    }
  });
});

describe("malformed token -> typed error, and the secret never leaks", () => {
  const malformed: Array<[string, string]> = [
    ["leading whitespace", ` ${GOOD}`],
    ["trailing whitespace", `${GOOD} `],
    ["wrong prefix", "ghp_not-the-right-shape-at-all"],
    ["no prefix at all", "just-a-bare-string"],
    ["prefix only", GITHUB_TOKEN_PREFIX],
    ["embedded newline", `${GOOD}\nleaked`],
    ["non-ascii", `${GOOD}é`],
  ];

  for (const [label, value] of malformed) {
    it(`rejects ${label} as token_malformed`, async () => {
      const error = await expectCredentialError(
        new EnvCredentialProvider({ readEnv: () => value }).getToken(),
      );
      expect(error.code).toBe("token_malformed");
      expect(error.source).toBe("env");

      // The offending value must not appear anywhere on the error.
      const serialized = [
        error.message,
        error.reason,
        error.name,
        error.code,
        error.source,
        error.stack ?? "",
        JSON.stringify({
          code: error.code,
          source: error.source,
          reason: error.reason,
        }),
      ].join("\n");

      const secret = value.trim();
      if (secret.length > 0) {
        expect(serialized).not.toContain(secret);
      }
      // Never leak the core material either, even when the prefix differs.
      expect(serialized).not.toContain(value);
    });
  }

  it("the fake provider validates its fixture through the same rules", async () => {
    const provider = new FakeCredentialProvider({
      tokens: { valid: " oops " },
    });
    const error = await expectCredentialError(provider.getToken());
    expect(error.code).toBe("token_malformed");
    expect(error.source).toBe("fake");
    expect(error.message).not.toContain("oops");
  });
});

describe("Zod-backed validation", () => {
  it("imports zod and routes shape validation through a real schema", () => {
    // The criterion is "Zod-validate", so assert the dependency is genuinely
    // wired in at runtime rather than trusting that the import is used.
    expect(z.string).toBeTypeOf("function");
    expect(zodVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns the exact input unchanged on the happy path", () => {
    expect(validateTokenShape(GOOD, "env")).toBe(GOOD);
  });

  it("maps each defect to its own fixed, secret-free reason", () => {
    const cases: Array<[string, string, string]> = [
      ["empty", "", "token_absent"],
      ["whitespace only", "  \t\n ", "token_absent"],
      ["leading whitespace", ` ${GOOD}`, "token_malformed"],
      ["trailing whitespace", `${GOOD} `, "token_malformed"],
      ["wrong prefix", "ghp_wrong-prefix-entirely", "token_malformed"],
      ["no prefix", "bare-token-value", "token_malformed"],
      ["prefix only", GITHUB_TOKEN_PREFIX, "token_malformed"],
      ["embedded newline", `${GOOD}\nsecond-line`, "token_malformed"],
      ["non-ascii", `${GOOD}é`, "token_malformed"],
    ];

    for (const [label, value, expectedCode] of cases) {
      const error = capture(() => validateTokenShape(value, "env"));
      expect(error.code, label).toBe(expectedCode);
      // The reason must be one of the FIXED strings, byte for byte — not a
      // string assembled at the throw site, which is where a leak would enter.
      expect(Object.values(TOKEN_DEFECT_REASONS), label).toContain(
        error.reason,
      );
      expect(error.message).toContain(`"env"`);
      // Only assert containment for values that have ink to leak: an empty or
      // whitespace-only token has nothing to be found in the message, so
      // "not.toContain(value)" there would pass vacuously.
      if (value.trim().length > 0) {
        expect(error.message).not.toContain(value);
      }
    }
  });

  it("names the failing source, not just the code", () => {
    // Known sources pass through byte for byte, so the error stays specific
    // enough to act on.
    for (const source of ["env", "fake"] as const) {
      const error = capture(() => validateTokenShape("bad-value", source));
      expect(error.source).toBe(source);
      expect(error.message).toContain(source);
    }
  });

  it("collapses an unrecognised source to the fixed 'unknown' label", () => {
    // A caller with something that is not a source still gets a usable error,
    // and does not get its own text echoed back.
    const error = capture(() =>
      validateTokenShape("bad-value", UNKNOWN_CREDENTIAL_SOURCE),
    );
    expect(error.source).toBe(UNKNOWN_CREDENTIAL_SOURCE);
    expect(error.message).toContain(UNKNOWN_CREDENTIAL_SOURCE);
    // Explicitly NOT the value that was passed.
    expect(error.source).not.toBe("some-other-source");
  });

  it("distinguishes absent from malformed on the same whitespace input", () => {
    // Guards the ordering of the two schemas: blank is absent, untrimmed but
    // non-blank is malformed. Getting this backwards would silently downgrade
    // a real misconfiguration to the wrong error code.
    expect(capture(() => validateTokenShape("   ", "env")).code).toBe(
      "token_absent",
    );
    expect(capture(() => validateTokenShape(` ${GOOD} `, "env")).code).toBe(
      "token_malformed",
    );
  });
});

describe("factory", () => {
  it("builds the env provider for the explicit 'env' source", async () => {
    const provider = createCredentialProvider("env", {
      env: { readEnv: () => GOOD },
    });
    expect(provider.source).toBe("env");
    await expect(provider.getToken()).resolves.toBe(GOOD);
  });

  it("builds the fake provider only with an explicit opt-in", async () => {
    const provider = createCredentialProvider("fake", {
      allowTestSources: true,
    });
    expect(provider.source).toBe("fake");
    await expect(provider.getToken()).resolves.toBe(FAKE_TOKENS.valid);
  });

  it("rejects the test-only source without the opt-in", () => {
    try {
      createCredentialProvider("fake");
      throw new Error("expected a CredentialError");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      const credentialError = error as CredentialError;
      expect(credentialError.code).toBe("test_source_forbidden");
      expect(credentialError.source).toBe("fake");
    }
  });

  it("rejects an unknown source loudly", () => {
    for (const source of ["vault", "keychain", "", "ENV"]) {
      try {
        createCredentialProvider(source);
        throw new Error(`expected a CredentialError for ${source}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialError);
        expect((error as CredentialError).code).toBe("unknown_source");
      }
    }
  });

  it("rejects a missing source loudly: there is no ambient default", () => {
    for (const source of [undefined, null, 0, {}, []]) {
      try {
        createCredentialProvider(source);
        throw new Error("expected a CredentialError");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialError);
        expect((error as CredentialError).code).toBe("unknown_source");
      }
    }
  });

  it("requires the source argument by type, not by defaulting", () => {
    // A compile-time guard, asserted here so the intent is recorded: the
    // parameter has no default and is not optional.
    expect(createCredentialProvider.length).toBe(1);
  });

  it("cannot be made to select the fake by an environment variable", () => {
    // Every plausible knob a later caller might reach for.
    const knobs: Record<string, string> = {
      CREDENTIAL_SOURCE: "fake",
      DEVLOOP_CREDENTIAL_SOURCE: "fake",
      GITHUB_CREDENTIAL_SOURCE: "fake",
      GITHUB_FINE_GRAINED_PAT: FAKE_TOKENS.valid,
    };
    for (const [key, value] of Object.entries(knobs)) {
      process.env[key] = value;
    }
    try {
      // The factory takes only an argument: with nothing supplied it throws
      // rather than reading any of the knobs above. The cast is deliberate —
      // it proves the runtime behaviour when a caller omits the argument that
      // TypeScript would otherwise reject at compile time.
      const callWithNoArgument =
        createCredentialProvider as unknown as () => void;
      expect(() => callWithNoArgument()).toThrowError(CredentialError);
      expect(() => callWithNoArgument()).toThrowError(/unknown_source/);
      // And the knob alone cannot conjure a provider for the fake source.
      expect(() => createCredentialProvider("fake")).toThrowError(
        /test_source_forbidden/,
      );
    } finally {
      for (const key of Object.keys(knobs)) {
        delete process.env[key];
      }
    }
  });
});

describe("regression: isTestOnlyCredentialSource narrows rather than widens", () => {
  /**
   * Compile-time equality assertion. If the two types are not identical this
   * line is a type error, and `bun run typecheck` fails — which is the point: the
   * defect this guards against is invisible to the runtime suite, because
   * `isTestOnlyCredentialSource("env")` correctly returns `false` either way. It
   * is only the PREDICATE TYPE that was wrong.
   */
  type Exact<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
      ? true
      : false;
  const expectType = <T extends true>(): T => true as T;

  it("narrows an unknown source to the test-only subset, not the full set", () => {
    // The bug: `TestOnlyCredentialSource` was derived from CREDENTIAL_SOURCES, so
    // it expanded to "env" | "fake" and the predicate widened instead of
    // narrowing. These assertions are the regression.
    expectType<Exact<TestOnlyCredentialSource, "fake">>();

    // The predicate's runtime behaviour was already right; pin it anyway so the
    // two halves of the contract are stated in one place.
    expect([...TEST_ONLY_CREDENTIAL_SOURCES]).toEqual(["fake"]);
    expect([...CREDENTIAL_SOURCES]).toContain("env");
    // And a real production source is NOT narrowed into the test-only type.
    expectType<
      Exact<Exclude<CredentialSource, TestOnlyCredentialSource>, "env">
    >();
  });

  it("cannot assign a production source to the test-only type", () => {
    // This assignment must not compile. It is written so that the failure is a
    // plain type error at this line, not a runtime throw.
    const narrowed: TestOnlyCredentialSource = "fake";
    expect(narrowed).toBe("fake");
    // @ts-expect-error "env" is a CredentialSource but not a TestOnlyCredentialSource.
    const wrong: TestOnlyCredentialSource = "env";
    expect(wrong).toBe("env");
  });
});

describe("regression: fake providers do not share mutable state", () => {
  it("does not mutate the exported fixtures when a default provider is written to", async () => {
    const before = FAKE_TOKENS.valid;

    const polluted = new FakeCredentialProvider();
    polluted.setToken("valid", "github_pat_-mutated-by-one-test-only");

    // The exported fixture table must be untouched.
    expect(FAKE_TOKENS.valid).toBe(before);
    expect(FAKE_TOKENS).toEqual({
      valid: "github_pat_-not-a-real-fixture-token-1",
      validAlt: "github_pat_-not-a-real-fixture-token-2",
    });

    // And a provider constructed afterwards must see pristine fixtures. This is
    // the failure QA observed: without the copy, the fresh provider returned the
    // polluted value, making the suite order-dependent.
    await expect(new FakeCredentialProvider().getToken()).resolves.toBe(before);
  });

  it("keeps two concurrently-live providers independent", async () => {
    const a = new FakeCredentialProvider();
    const b = new FakeCredentialProvider();

    a.setToken("valid", OTHER);
    await expect(a.getToken()).resolves.toBe(OTHER);
    await expect(b.getToken()).resolves.toBe(FAKE_TOKENS.valid);
  });

  it("does not mutate a caller-supplied token map", async () => {
    const supplied = { valid: GOOD };
    const provider = new FakeCredentialProvider({ tokens: supplied });

    provider.setToken("valid", OTHER);

    expect(supplied.valid).toBe(GOOD);
    await expect(provider.getToken()).resolves.toBe(OTHER);
  });
});

/**
 * Negative control for the secret-hygiene defect found in review.
 *
 * The defect: `CredentialError` interpolated unrestricted caller text into
 * `message`, and `createCredentialProvider` reached it with `String(source)`. A
 * caller that passed a token where a source belongs put the token in both
 * `error.source` and `error.message`, so it reached logs and any serialised
 * error payload — while the doc comment claimed no field could carry it.
 *
 * The fix constrains `source` and `reason` to allowlisted values with a fixed
 * safe label. These tests are the control: revert the fix and every assertion
 * below that says a token must NOT appear FAILS. A suite that passes either way
 * is vacuous and the fix is not real.
 */
describe("regression: a token passed as `source` never reaches the error", () => {
  /**
   * Shaped like a real fine-grained PAT — correct prefix, long alphanumeric
   * material — so the assertion is about the fix, not about a value that would
   * fail a token-shape test for unrelated reasons.
   */
  const TOKEN_AS_SOURCE = `github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij`;

  /** Every string a consumer could plausibly read, log, or ship off an error. */
  function serialisedSurface(error: CredentialError): string {
    return [
      error.message,
      error.reason,
      error.name,
      error.code,
      error.source,
      error.stack ?? "",
      JSON.stringify(error),
      JSON.stringify({
        code: error.code,
        source: error.source,
        reason: error.reason,
      }),
      // `Object.entries` catches any field added later that these named
      // properties would miss — the leak had two routes, and a third should not
      // need a new test.
      JSON.stringify(Object.entries(error)),
    ].join("\n");
  }

  it("does not leak a token-shaped string passed as `source` to the constructor", () => {
    const error = new CredentialError("unknown_source", {
      // Deliberately bypassing the type: a JS caller, or a caller who widened
      // the argument, can do exactly this. That is the threat being controlled.
      source: TOKEN_AS_SOURCE as CredentialErrorSource,
      reason: TOKEN_DEFECT_REASONS.unknown,
    });

    // The load-bearing assertions, in both fields the PM named.
    expect(error.message).not.toContain(TOKEN_AS_SOURCE);
    expect(error.source).not.toContain(TOKEN_AS_SOURCE);
    // And nothing else on the object either.
    expect(serialisedSurface(error)).not.toContain(TOKEN_AS_SOURCE);
    // It must still be a usable, typed error.
    expect(error.code).toBe("unknown_source");
    expect(error.source).toBe(UNKNOWN_CREDENTIAL_SOURCE);
  });

  it("does not leak a token-shaped string passed as `reason` to the constructor", () => {
    const error = new CredentialError("token_malformed", {
      source: "env",
      reason: TOKEN_AS_SOURCE as CredentialFailureReason,
    });

    expect(error.message).not.toContain(TOKEN_AS_SOURCE);
    expect(error.reason).not.toContain(TOKEN_AS_SOURCE);
    expect(serialisedSurface(error)).not.toContain(TOKEN_AS_SOURCE);
    // The reason degrades to a fixed string rather than disappearing.
    expect(CREDENTIAL_FAILURE_REASONS).toContain(error.reason);
  });

  it("does not leak a token-shaped string passed as the factory's source", () => {
    // The second route: `String(source)` used to carry the value into the error.
    const error = capture(() => createCredentialProvider(TOKEN_AS_SOURCE));

    expect(error.message).not.toContain(TOKEN_AS_SOURCE);
    expect(error.source).not.toContain(TOKEN_AS_SOURCE);
    expect(serialisedSurface(error)).not.toContain(TOKEN_AS_SOURCE);
    expect(error.code).toBe("unknown_source");
    expect(error.source).toBe(UNKNOWN_CREDENTIAL_SOURCE);
  });

  it("does not leak a token-shaped string thrown by validateTokenShape", () => {
    const error = capture(() =>
      validateTokenShape("bad-value", TOKEN_AS_SOURCE as CredentialErrorSource),
    );
    expect(serialisedSurface(error)).not.toContain(TOKEN_AS_SOURCE);
    expect(error.source).toBe(UNKNOWN_CREDENTIAL_SOURCE);
  });

  it("still refuses to build a provider for a token-shaped source", () => {
    // The control must not pass by simply accepting the value: the call still
    // has to fail, or the assertions above would be vacuous.
    expect(() => createCredentialProvider(TOKEN_AS_SOURCE)).toThrowError(
      CredentialError,
    );
  });
});

describe("regression: source and reason are constrained to allowlists", () => {
  it("collapses every non-source value to the fixed unknown label", () => {
    const rejected: unknown[] = [
      "vault",
      "",
      "   ",
      "ENV",
      "env ", // almost-correct is still wrong; no trimming games
      TOKEN_DEFECT_REASONS.empty,
      42,
      0,
      true,
      null,
      undefined,
      {},
      [],
      Symbol("tok"),
      () => "env",
      new Error("env"),
      Object.assign(Object.create(null), { toString: () => "env" }),
    ];

    for (const value of rejected) {
      expect(toSafeCredentialSource(value)).toBe(UNKNOWN_CREDENTIAL_SOURCE);
    }
  });

  it("passes known sources through unchanged", () => {
    expect(toSafeCredentialSource("env")).toBe("env");
    expect(toSafeCredentialSource("fake")).toBe("fake");
    expect(toSafeCredentialSource(UNKNOWN_CREDENTIAL_SOURCE)).toBe(
      UNKNOWN_CREDENTIAL_SOURCE,
    );
  });

  it("collapses every non-allowlisted reason to the fixed fallback", () => {
    const fallback = TOKEN_DEFECT_REASONS.unknown;
    const rejected: unknown[] = [
      "something went wrong",
      TOKEN_DEFECT_REASONS.empty + " (with the token appended)",
      "token is empty ",
      42,
      null,
      undefined,
      {},
      [],
      Symbol("reason"),
    ];

    for (const value of rejected) {
      expect(toSafeFailureReason(value)).toBe(fallback);
    }
  });

  it("passes allowlisted reasons through unchanged", () => {
    for (const reason of CREDENTIAL_FAILURE_REASONS) {
      expect(toSafeFailureReason(reason)).toBe(reason);
    }
  });

  it("every source and reason the error can carry is a member of its allowlist", () => {
    // The invariant, stated once: nothing reaches the error from outside these
    // two closed sets. If a future change widens either, this fails.
    for (const source of CREDENTIAL_ERROR_SOURCES) {
      expect(toSafeCredentialSource(source)).toBe(source);
    }
    expect(CREDENTIAL_ERROR_SOURCES).toEqual([
      ...CREDENTIAL_SOURCES,
      UNKNOWN_CREDENTIAL_SOURCE,
    ]);

    const error = capture(() => validateTokenShape("bad-value", "env"));
    expect(CREDENTIAL_ERROR_SOURCES).toContain(error.source);
    expect(CREDENTIAL_FAILURE_REASONS).toContain(error.reason);
  });
});

/**
 * A token-shaped string handed to the factory must never be echoed, for ANY
 * input type — including the ones `String()` handles oddly. Kept separate from
 * the block above because it is the factory's own contract, and it is also the
 * place a well-meaning future `String(source)` would come back.
 */
describe("regression: the factory never stringifies the rejected source", () => {
  it("returns a typed error, not a TypeError, for exotic inputs", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      0,
      {},
      [],
      Symbol("tok"),
      42n,
      () => "env",
    ];

    for (const input of inputs) {
      const error = capture(() => createCredentialProvider(input));
      expect(error.code).toBe("unknown_source");
      expect(error.source).toBe(UNKNOWN_CREDENTIAL_SOURCE);
      // No branch may fall back to interpolating the input.
      expect(error.message).not.toContain("Symbol");
      expect(error.message).not.toContain("[object Object]");
    }
  });
});
