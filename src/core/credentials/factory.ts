/**
 * The only sanctioned way to obtain a {@link CredentialProvider}.
 *
 * The source is an explicit ARGUMENT. There is no ambient default, no fallback
 * order, and no environment variable that can select a source: a missing or
 * unknown source fails loudly with a {@link CredentialError}. The `fake` source
 * additionally requires an explicit `allowTestSources` opt-in so a fixture
 * provider cannot be reached from production code by accident or by
 * configuration.
 */

import {
  CredentialError,
  TOKEN_DEFECT_REASONS,
  TOKEN_SOURCE_REASONS,
  UNKNOWN_CREDENTIAL_SOURCE,
  assertValidTokenProfile,
  isCredentialSource,
  isTestOnlyCredentialSource,
} from "./provider";
import type {
  CredentialProvider,
  CredentialSource,
  TokenProfile,
} from "./provider";
import { createEnvCredentialProvider } from "./env-provider";
import type { EnvCredentialProviderOptions } from "./env-provider";
import { createFakeCredentialProvider } from "./fakes";
import type { FakeCredentialProviderOptions } from "./fakes";

export interface CreateCredentialProviderOptions {
  /**
   * Explicit opt-in required before a test-only source (`fake`) may be built.
   * Should only ever be passed from a test.
   */
  readonly allowTestSources?: boolean;
  /** Passed through to the env provider when the `env` source is selected. */
  readonly env?: Omit<EnvCredentialProviderOptions, "profile">;
  /** Passed through to the fake provider when the `fake` source is selected. */
  readonly fake?: Omit<FakeCredentialProviderOptions, "profile">;
  /**
   * Which provider's token shape to build for. Required.
   *
   * B19: the factory is the single sanctioned way to obtain a provider, so this
   * is where the provider-specific half of a token's shape enters core — passed
   * in by the caller, never defaulted. It is declared here rather than nested
   * under `env`/`fake` because it is required for BOTH sources and because a
   * caller must not be able to supply one source's profile for another's.
   *
   * Validated once here so an unusable profile fails before any provider is
   * constructed rather than on the first token fetch.
   */
  readonly profile: TokenProfile;
}

/**
 * Build a provider for `source`.
 *
 * @throws {CredentialError} `unknown_source` when `source` is missing or not a
 * known {@link CredentialSource}; `test_source_forbidden` when a test-only
 * source is requested without `allowTestSources`; `token_malformed` when
 * `options.profile` is blank in either half.
 *
 * Secret hygiene: the rejected `source` value is NEVER stringified into the
 * error. `String(source)` on a caller-controlled argument is a leak by a second
 * route — a caller that passes a token where a source belongs would put it in
 * `error.source` and `error.message`, which is exactly what the factory exists
 * to prevent. The fixed {@link UNKNOWN_CREDENTIAL_SOURCE} label is used instead.
 *
 * Note there is deliberately no guard for a Symbol argument: `String(symbol)` is
 * legal in JS (it is `"" + symbol` that throws), so this path already yields a
 * typed `CredentialError` for every input type. Adding a Symbol check would be
 * dead code asserting protection against a bug that does not exist.
 */
export function createCredentialProvider(
  source: unknown,
  options: CreateCredentialProviderOptions,
): CredentialProvider {
  // B19: `options` (and therefore `profile`) is REQUIRED by the type. It is
  // still tolerated as absent at runtime, because this factory's documented
  // contract is that ANY input yields a TYPED CredentialError rather than a
  // TypeError — a plain property read on `undefined` would break that contract
  // for a JS caller, or a TS caller who widened the argument. The failure is
  // still loud and still names the cause.
  const profile = options?.profile;
  if (profile === undefined) {
    throw new CredentialError("token_malformed", {
      source: UNKNOWN_CREDENTIAL_SOURCE,
      reason: TOKEN_DEFECT_REASONS.noProfilePrefix,
    });
  }
  assertValidTokenProfile(profile);

  if (!isCredentialSource(source)) {
    throw new CredentialError("unknown_source", {
      source: UNKNOWN_CREDENTIAL_SOURCE,
      reason: TOKEN_SOURCE_REASONS.unknownSource,
    });
  }

  if (isTestOnlyCredentialSource(source) && options.allowTestSources !== true) {
    throw new CredentialError("test_source_forbidden", {
      source,
      reason: TOKEN_SOURCE_REASONS.testSourceForbidden,
    });
  }

  const typedSource: CredentialSource = source;

  switch (typedSource) {
    case "env":
      return createEnvCredentialProvider({ ...options.env, profile });
    case "fake":
      return createFakeCredentialProvider({ ...options.fake, profile });
    default: {
      // Exhaustiveness guard: a new source cannot be added without a branch here.
      // `void` so the assertion counts as a use — the variable's whole job is to
      // be a compile-time error if the switch above is ever left incomplete.
      const unreachable: never = typedSource;
      void unreachable;
      throw new CredentialError("unknown_source", {
        // `unreachable` is the compiler's assertion that this is `never`, so it
        // is not a runtime value that could carry anything. `unknown` is used
        // rather than `String(unreachable)` to keep the no-interpolation rule
        // true even of the dead branch.
        source: UNKNOWN_CREDENTIAL_SOURCE,
        reason: TOKEN_SOURCE_REASONS.noImplementation,
      });
    }
  }
}
