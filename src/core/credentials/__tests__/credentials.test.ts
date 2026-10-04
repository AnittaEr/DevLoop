import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import zodPackage from "zod/package.json" with { type: "json" };

import {
  CREDENTIAL_ERROR_SOURCES,
  CREDENTIAL_FAILURE_REASONS,
  CREDENTIAL_SOURCES,
  CredentialError,
  TEST_ONLY_CREDENTIAL_SOURCES,
  TOKEN_DEFECT_REASONS,
  TOKEN_SOURCE_REASONS,
  UNKNOWN_CREDENTIAL_SOURCE,
  isCredentialSource,
  isTestOnlyCredentialSource,
  toSafeCredentialSource,
  toSafeFailureReason,
  validateTokenShape,
} from "../provider";
import type {
  CredentialErrorCode,
  CredentialErrorSource,
  CredentialFailureReason,
  CredentialSource,
  TestOnlyCredentialSource,
  TokenProfile,
} from "../provider";
import { EnvCredentialProvider } from "../env-provider";
import {
  FAKE_TOKEN_KEY,
  FakeCredentialProvider,
  createFakeCredentialProvider,
  fakeTokensFor,
} from "../fakes";
import { createCredentialProvider } from "../factory";
import type { CreateCredentialProviderOptions } from "../factory";

/**
 * `TokenDefectReason` is deliberately not exported from `provider.ts` — that
 * file is owned by the I4 batch and this card must not edit it. It is derived
 * here from the same table, so this alias cannot drift from the values asserted
 * below: both sides read `TOKEN_DEFECT_REASONS`.
 */
type DefectReason =
  (typeof TOKEN_DEFECT_REASONS)[keyof typeof TOKEN_DEFECT_REASONS];

/**
 * B19 - a deliberately FICTIONAL token profile.
 *
 * The prefix and env-var name used to be imported from `../provider`, which put
 * one vendor's real token format in this file. Supplying a profile here instead
 * is what keeps `src/core/` provider-agnostic: core states the SHAPE a token
 * must have and the shape's owner injects it.
 *
 * The prefix is fictional, so this file asserts the validation logic and cannot
 * be mistaken for knowledge of any real provider's token format.
 */
const TEST_PROFILE: TokenProfile = {
  prefix: "vndr_",
  envVar: "VENDOR_SAMPLE_PAT",
};
const FAKE_TOKENS = fakeTokensFor(TEST_PROFILE);

/** Synthetic, clearly-not-a-secret tokens. Not a real token shape. */
const GOOD = FAKE_TOKENS.valid;
const OTHER = `${TEST_PROFILE.prefix}not-a-real-fixture-token-2`;

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

/**
 * Run a synchronous thunk that must throw a CredentialError, and return it.
 *
 * `label` is REQUIRED and appears in every failure message. This helper is
 * called from inside `for` loops over labelled cases; without the label a
 * failure names no input at all, so a broken case is indistinguishable from a
 * broken loop.
 */
function capture(label: string, thunk: () => unknown): CredentialError {
  try {
    thunk();
  } catch (error) {
    if (!(error instanceof CredentialError)) {
      throw new Error(
        `expected a CredentialError for ${label}, got ${String(error)}`,
        { cause: error },
      );
    }
    return error;
  }
  throw new Error(
    `expected a CredentialError for ${label} but nothing was thrown`,
  );
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

const originalEnv = process.env[TEST_PROFILE.envVar];

beforeEach(() => {
  delete process.env[TEST_PROFILE.envVar];
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[TEST_PROFILE.envVar];
  } else {
    process.env[TEST_PROFILE.envVar] = originalEnv;
  }
});

describe("CredentialProvider contract", () => {
  it("exposes a discriminant on every implementation", () => {
    expect(new EnvCredentialProvider({ profile: TEST_PROFILE }).source).toBe(
      "env",
    );
    expect(new FakeCredentialProvider({ profile: TEST_PROFILE }).source).toBe(
      "fake",
    );
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
      new EnvCredentialProvider({ profile: TEST_PROFILE, readEnv: () => GOOD }),
      new FakeCredentialProvider({ profile: TEST_PROFILE }),
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
    process.env[TEST_PROFILE.envVar] = GOOD;
    const provider = new EnvCredentialProvider({ profile: TEST_PROFILE });
    await expect(provider.getToken()).resolves.toBe(GOOD);
  });

  it("reads process.env lazily, not at module import time", async () => {
    // Constructed while the variable is unset, then set afterwards.
    const provider = new EnvCredentialProvider({ profile: TEST_PROFILE });
    await expectCredentialError(provider.getToken());
    process.env[TEST_PROFILE.envVar] = OTHER;
    await expect(provider.getToken()).resolves.toBe(OTHER);
  });

  it("honours an injected env reader", async () => {
    const provider = new EnvCredentialProvider({
      profile: TEST_PROFILE,
      readEnv: () => GOOD,
    });
    await expect(provider.getToken()).resolves.toBe(GOOD);
  });
});

describe("fake provider happy path", () => {
  it("returns the in-memory fixture value", async () => {
    await expect(
      new FakeCredentialProvider({ profile: TEST_PROFILE }).getToken(),
    ).resolves.toBe(FAKE_TOKENS.valid);
  });

  it("returns values from a caller-supplied in-memory map", async () => {
    const provider = new FakeCredentialProvider({
      profile: TEST_PROFILE,
      tokens: { valid: OTHER },
    });
    await expect(provider.getToken()).resolves.toBe(OTHER);
  });

  it("fails typed when the map has no value under the expected key", async () => {
    const provider = new FakeCredentialProvider({
      profile: TEST_PROFILE,
      tokens: {},
    });
    const error = await expectCredentialError(provider.getToken());
    expect(error.code).toBe("token_absent");
    expect(error.source).toBe("fake");
  });
});

describe("absent token -> typed error", () => {
  it("env provider throws token_absent when the variable is unset", async () => {
    const error = await expectCredentialError(
      new EnvCredentialProvider({ profile: TEST_PROFILE }).getToken(),
    );
    expect(error.code).toBe("token_absent");
    expect(error.source).toBe("env");
    expect(error.message).toContain(TOKEN_SOURCE_REASONS.envVarUnset);
  });

  it("env provider throws token_absent for an empty or whitespace value", async () => {
    for (const value of ["", "   ", "\t\n"]) {
      const error = await expectCredentialError(
        new EnvCredentialProvider({
          profile: TEST_PROFILE,
          readEnv: () => value,
        }).getToken(),
      );
      expect(error.code).toBe("token_absent");
      expect(error.source).toBe("env");
    }
  });

  it("rejects a non-string provider result as token_absent", () => {
    try {
      validateTokenShape(undefined, "env", TEST_PROFILE);
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
    ["wrong prefix", "other_not-the-right-shape-at-all"],
    ["no prefix at all", "just-a-bare-string"],
    ["prefix only", TEST_PROFILE.prefix],
    ["embedded newline", `${GOOD}\nleaked`],
    ["non-ascii", `${GOOD}é`],
  ];

  for (const [label, value] of malformed) {
    it(`rejects ${label} as token_malformed`, async () => {
      const error = await expectCredentialError(
        new EnvCredentialProvider({
          profile: TEST_PROFILE,
          readEnv: () => value,
        }).getToken(),
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
      profile: TEST_PROFILE,
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
    expect(validateTokenShape(GOOD, "env", TEST_PROFILE)).toBe(GOOD);
  });

  it("maps each defect to its own fixed, secret-free reason", () => {
    // `[label, value, expected code, expected reason]` — the reason is asserted
    // for EQUALITY, not membership.
    //
    // FINDING 8: this used to assert only that `error.reason` was *a member* of
    // TOKEN_DEFECT_REASONS. Membership is far too weak: swapping the `untrimmed`
    // case's expected mapping to `wrongPrefix`, or reordering the schema's
    // checks so "wrong prefix" reported "untrimmed", left the suite GREEN. The
    // provider contract is that a given defect maps to one SPECIFIC stable
    // keyed string — that is the whole point of the closed table — so that is
    // what is asserted here. Negative control: swap two entries in this table
    // and this test FAILS.
    const cases: Array<[string, string, CredentialErrorCode, DefectReason]> = [
      ["empty", "", "token_absent", TOKEN_DEFECT_REASONS.empty],
      [
        "whitespace only",
        "  \t\n ",
        "token_absent",
        TOKEN_DEFECT_REASONS.empty,
      ],
      [
        "leading whitespace",
        ` ${GOOD}`,
        "token_malformed",
        TOKEN_DEFECT_REASONS.untrimmed,
      ],
      [
        "trailing whitespace",
        `${GOOD} `,
        "token_malformed",
        TOKEN_DEFECT_REASONS.untrimmed,
      ],
      [
        "wrong prefix",
        "other_wrong-prefix-entirely",
        "token_malformed",
        TOKEN_DEFECT_REASONS.wrongPrefix,
      ],
      [
        "no prefix",
        "bare-token-value",
        "token_malformed",
        TOKEN_DEFECT_REASONS.wrongPrefix,
      ],
      [
        "prefix only",
        TEST_PROFILE.prefix,
        "token_malformed",
        TOKEN_DEFECT_REASONS.noMaterial,
      ],
      [
        "embedded newline",
        `${GOOD}\nsecond-line`,
        "token_malformed",
        TOKEN_DEFECT_REASONS.nonPrintable,
      ],
      [
        "non-ascii",
        `${GOOD}é`,
        "token_malformed",
        TOKEN_DEFECT_REASONS.nonPrintable,
      ],
    ];

    for (const [label, value, expectedCode, expectedReason] of cases) {
      const error = capture(label, () =>
        validateTokenShape(value, "env", TEST_PROFILE),
      );
      expect(error.code, label).toBe(expectedCode);
      // Equality, not membership. Also still asserts the reason is one of the
      // FIXED strings byte for byte — not assembled at the throw site, which is
      // where a leak would enter.
      expect(error.reason, label).toBe(expectedReason);
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
      const error = capture(`source ${source}`, () =>
        validateTokenShape("bad-value", source, TEST_PROFILE),
      );
      expect(error.source).toBe(source);
      expect(error.message).toContain(source);
    }
  });

  it("collapses an unrecognised source to the fixed 'unknown' label", () => {
    // A caller with something that is not a source still gets a usable error,
    // and does not get its own text echoed back.
    const error = capture("unrecognised source", () =>
      validateTokenShape("bad-value", UNKNOWN_CREDENTIAL_SOURCE, TEST_PROFILE),
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
    expect(
      capture("blank", () => validateTokenShape("   ", "env", TEST_PROFILE))
        .code,
    ).toBe("token_absent");
    expect(
      capture("untrimmed", () =>
        validateTokenShape(` ${GOOD} `, "env", TEST_PROFILE),
      ).code,
    ).toBe("token_malformed");
  });

  /**
   * FINDING 7 — negative control.
   *
   * `capture()` used to throw a bare label-less `Error`, and its
   * `expect(error).toBeInstanceOf(CredentialError)` swallowed the case label on
   * the non-CredentialError path too. In a `for` loop over labelled cases that
   * made a failure name no input at all: the report said "expected a
   * CredentialError" and nothing about which of the nine rows was at fault.
   *
   * These two cases pin the property from both directions. If the label ever
   * drops out of the helper, BOTH of these fail.
   */
  it("capture() names the failing case when nothing was thrown", () => {
    expect(() => capture("some-distinctive-case-label", () => 42)).toThrowError(
      /some-distinctive-case-label/,
    );
  });

  it("capture() names the failing case when the wrong error type was thrown", () => {
    expect(() =>
      capture("another-distinctive-label", () => {
        throw new TypeError("not a CredentialError");
      }),
    ).toThrowError(/another-distinctive-label/);
  });
});

describe("factory", () => {
  it("builds the env provider for the explicit 'env' source", async () => {
    const provider = createCredentialProvider("env", {
      profile: TEST_PROFILE,
      env: { readEnv: () => GOOD },
    });
    expect(provider.source).toBe("env");
    await expect(provider.getToken()).resolves.toBe(GOOD);
  });

  it("builds the fake provider only with an explicit opt-in", async () => {
    const provider = createCredentialProvider("fake", {
      profile: TEST_PROFILE,
      allowTestSources: true,
    });
    expect(provider.source).toBe("fake");
    await expect(provider.getToken()).resolves.toBe(FAKE_TOKENS.valid);
  });

  it("rejects the test-only source without the opt-in", () => {
    try {
      createCredentialProvider("fake", { profile: TEST_PROFILE });
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
        createCredentialProvider(source, { profile: TEST_PROFILE });
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
        createCredentialProvider(source, { profile: TEST_PROFILE });
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
    expect(createCredentialProvider.length).toBe(2);
  });

  it("cannot be made to select the fake by an environment variable", () => {
    // Every plausible knob a later caller might reach for.
    const knobs: Record<string, string> = {
      CREDENTIAL_SOURCE: "fake",
      DEVLOOP_CREDENTIAL_SOURCE: "fake",
      VENDOR_CREDENTIAL_SOURCE: "fake",
      VENDOR_SAMPLE_PAT: FAKE_TOKENS.valid,
    };
    for (const [key, value] of Object.entries(knobs)) {
      process.env[key] = value;
    }
    try {
      // The factory takes only an argument: with nothing supplied it throws
      // rather than reading any of the knobs above. The cast is deliberate —
      // it proves the runtime behaviour when a caller omits the argument that
      // TypeScript would otherwise reject at compile time.
      // The subject here is a missing SOURCE, so the options ARE supplied and
      // the source omitted: that is the ambient-default question. It must fail
      // as an unknown SOURCE, which is only reachable when the profile check
      // has already passed — so this also proves the profile is not what makes
      // the call throw.
      const callWithNoSource = createCredentialProvider as unknown as (
        s: unknown,
        o: CreateCredentialProviderOptions,
      ) => void;
      expect(() =>
        callWithNoSource(undefined, { profile: TEST_PROFILE }),
      ).toThrowError(CredentialError);
      expect(() =>
        callWithNoSource(undefined, { profile: TEST_PROFILE }),
      ).toThrowError(/unknown_source/);

      // And omitting the options entirely is a missing PROFILE, not a crash:
      // still a typed CredentialError, never a TypeError.
      const callWithNoOptions = createCredentialProvider as unknown as (
        s?: unknown,
      ) => void;
      expect(() => callWithNoOptions()).toThrowError(CredentialError);
      expect(() => callWithNoOptions()).toThrowError(
        TOKEN_DEFECT_REASONS.noProfilePrefix,
      );
      // And the knob alone cannot conjure a provider for the fake source.
      expect(() =>
        createCredentialProvider("fake", { profile: TEST_PROFILE }),
      ).toThrowError(/test_source_forbidden/);
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
    const before = FAKE_TOKENS[FAKE_TOKEN_KEY];

    const polluted = new FakeCredentialProvider({ profile: TEST_PROFILE });
    polluted.setToken(`${TEST_PROFILE.prefix}mutated-by-one-test-only`);

    // The exported fixture table must be untouched.
    expect(FAKE_TOKENS[FAKE_TOKEN_KEY]).toBe(before);
    // FINDING 3: the table is now exactly ONE key. `validAlt` shipped with no
    // code path that could ever read it, which is what made the old
    // any-key-`setToken` look legitimate.
    expect(FAKE_TOKENS).toEqual({ valid: GOOD });
    expect(Object.keys(FAKE_TOKENS)).toEqual([FAKE_TOKEN_KEY]);

    // And a provider constructed afterwards must see pristine fixtures. This is
    // the failure QA observed: without the copy, the fresh provider returned the
    // polluted value, making the suite order-dependent.
    await expect(
      new FakeCredentialProvider({ profile: TEST_PROFILE }).getToken(),
    ).resolves.toBe(before);
  });

  it("keeps two concurrently-live providers independent", async () => {
    const a = new FakeCredentialProvider({ profile: TEST_PROFILE });
    const b = new FakeCredentialProvider({ profile: TEST_PROFILE });

    a.setToken(OTHER);
    await expect(a.getToken()).resolves.toBe(OTHER);
    await expect(b.getToken()).resolves.toBe(FAKE_TOKENS[FAKE_TOKEN_KEY]);
  });

  it("does not mutate a caller-supplied token map", async () => {
    const supplied = { [FAKE_TOKEN_KEY]: GOOD };
    const provider = new FakeCredentialProvider({
      profile: TEST_PROFILE,
      tokens: supplied,
    });

    provider.setToken(OTHER);

    expect(supplied[FAKE_TOKEN_KEY]).toBe(GOOD);
    await expect(provider.getToken()).resolves.toBe(OTHER);
  });
});

/**
 * FINDING 3 — negative control.
 *
 * The defect: `setToken(key, value)` accepted any `string` while `getToken()`
 * hardcoded `this.tokens.valid`. Registering `setToken("alt", …)` therefore
 * succeeded, type-checked, and had NO effect on `getToken()` — a fixture that
 * could be registered and never read. `FAKE_TOKENS.validAlt` was the standing
 * proof: it shipped in the fixture table and no code path could reach it.
 *
 * The fix takes the card's first option — narrow the API to ONE documented key
 * ({@link FAKE_TOKEN_KEY}), delete `validAlt`, drop the `key` parameter. These
 * assertions pin that the narrowing is real rather than cosmetic.
 */
describe("FINDING 3: the fake provider reads exactly one documented key", () => {
  it("the fixture table has exactly one key and it is the documented one", () => {
    expect(FAKE_TOKEN_KEY).toBe("valid");
    expect(Object.keys(FAKE_TOKENS)).toEqual(["valid"]);
    // `validAlt` is gone, not merely unused.
    expect(FAKE_TOKENS).not.toHaveProperty("validAlt");
  });

  it("setToken takes no key, so there is no key a caller could get wrong", () => {
    // Compile-time guard, asserted at runtime so the intent is recorded: the
    // arity is 1. If a `key` parameter is ever re-added, this fails and so does
    // `bun run typecheck` on the call sites below.
    expect(FakeCredentialProvider.prototype.setToken.length).toBe(1);
    expect(createFakeCredentialProvider.length).toBe(1);
  });

  it("a fixture written through setToken IS reachable via getToken", async () => {
    // The property that was broken: whatever setToken registers, getToken must
    // return. With the old any-key API a non-`valid` key was write-only.
    const provider = new FakeCredentialProvider({ profile: TEST_PROFILE });
    provider.setToken(OTHER);
    await expect(provider.getToken()).resolves.toBe(OTHER);
  });

  it("a caller-supplied map under a non-documented key is unreachable, by design", async () => {
    // The narrowing's cost, stated as a test so it cannot be quietly undone.
    // `alt` is not {@link FAKE_TOKEN_KEY}, so it cannot be read back — which is
    // precisely why the API no longer invites callers to use one.
    const provider = new FakeCredentialProvider({
      profile: TEST_PROFILE,
      tokens: { alt: OTHER } as never,
    });
    const error = await expectCredentialError(provider.getToken());
    expect(error.code).toBe("token_absent");
    expect(error.reason).toBe(TOKEN_SOURCE_REASONS.fixtureMissing);
  });

  it("an empty map is the fixtureMissing path, not a crash", async () => {
    const provider = new FakeCredentialProvider({
      profile: TEST_PROFILE,
      tokens: {},
    });
    const error = await expectCredentialError(provider.getToken());
    expect(error.code).toBe("token_absent");
    expect(error.reason).toBe(TOKEN_SOURCE_REASONS.fixtureMissing);
  });
});

/**
 * FINDING 4 — negative control.
 *
 * The defect: `raw === undefined || raw.trim().length === 0` reported BOTH as
 * `envVarUnset` — "... is not set". An unset-by-appearance variable set to
 * `"   "` was
 * therefore reported as an unset variable, sending the operator after a missing
 * export when the real fault was a stray space or an empty value committed to a
 * `.env`.
 */
describe("FINDING 4: blank-but-present is not reported as 'not set'", () => {
  const NOT_SET = TOKEN_SOURCE_REASONS.envVarUnset;

  it("a whitespace-only env var is NOT reported as unset", async () => {
    for (const value of ["", "   ", "\t\n", " \n\t "]) {
      const error = await expectCredentialError(
        new EnvCredentialProvider({
          profile: TEST_PROFILE,
          readEnv: () => value,
        }).getToken(),
      );
      expect(error.reason, JSON.stringify(value)).not.toBe(NOT_SET);
      // Still absent, still typed — just for the accurate reason.
      expect(error.code, JSON.stringify(value)).toBe("token_absent");
      expect(error.reason, JSON.stringify(value)).toBe(
        TOKEN_DEFECT_REASONS.empty,
      );
      // And it does not claim the variable is missing either.
      expect(error.message).not.toContain("is not set");
    }
  });

  it("a genuinely unset env var IS still reported as not set", async () => {
    // The control must not pass by dropping the message entirely: the absent
    // case is the one place where naming the variable is exactly right.
    const error = await expectCredentialError(
      new EnvCredentialProvider({
        profile: TEST_PROFILE,
        readEnv: () => undefined,
      }).getToken(),
    );
    expect(error.reason).toBe(NOT_SET);
    expect(error.code).toBe("token_absent");
    expect(error.message).toContain(TOKEN_SOURCE_REASONS.envVarUnset);
  });

  it("reads the real process.env, not only an injected reader", async () => {
    process.env[TEST_PROFILE.envVar] = "   ";
    const error = await expectCredentialError(
      new EnvCredentialProvider({ profile: TEST_PROFILE }).getToken(),
    );
    expect(error.reason).not.toBe(NOT_SET);
    expect(error.reason).toBe(TOKEN_DEFECT_REASONS.empty);
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
   * Shaped like a real token — correct prefix, long alphanumeric material — so
   * the assertion is about the fix, not about a value that would fail a
   * token-shape test for unrelated reasons.
   */
  const TOKEN_AS_SOURCE = `${TEST_PROFILE.prefix}redacted-placeholder-value`;

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
    const error = capture("token as factory source", () =>
      createCredentialProvider(TOKEN_AS_SOURCE, { profile: TEST_PROFILE }),
    );

    expect(error.message).not.toContain(TOKEN_AS_SOURCE);
    expect(error.source).not.toContain(TOKEN_AS_SOURCE);
    expect(serialisedSurface(error)).not.toContain(TOKEN_AS_SOURCE);
    expect(error.code).toBe("unknown_source");
    expect(error.source).toBe(UNKNOWN_CREDENTIAL_SOURCE);
  });

  it("does not leak a token-shaped string thrown by validateTokenShape", () => {
    const error = capture("token as validateTokenShape source", () =>
      validateTokenShape(
        "bad-value",
        TOKEN_AS_SOURCE as CredentialErrorSource,
        TEST_PROFILE,
      ),
    );
    expect(serialisedSurface(error)).not.toContain(TOKEN_AS_SOURCE);
    expect(error.source).toBe(UNKNOWN_CREDENTIAL_SOURCE);
  });

  it("still refuses to build a provider for a token-shaped source", () => {
    // The control must not pass by simply accepting the value: the call still
    // has to fail, or the assertions above would be vacuous.
    expect(() =>
      createCredentialProvider(TOKEN_AS_SOURCE, { profile: TEST_PROFILE }),
    ).toThrowError(CredentialError);
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

    const error = capture("allowlist invariant", () =>
      validateTokenShape("bad-value", "env", TEST_PROFILE),
    );
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
      // `typeof` in the label, not the value: interpolating the input into a
      // failure message is exactly the habit this whole block exists to catch.
      const error = capture(`factory source ${typeof input}`, () =>
        createCredentialProvider(input, { profile: TEST_PROFILE }),
      );
      expect(error.code).toBe("unknown_source");
      expect(error.source).toBe(UNKNOWN_CREDENTIAL_SOURCE);
      // No branch may fall back to interpolating the input.
      expect(error.message).not.toContain("Symbol");
      expect(error.message).not.toContain("[object Object]");
    }
  });
});
