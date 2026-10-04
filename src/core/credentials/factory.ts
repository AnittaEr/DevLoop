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
  CREDENTIAL_SOURCES,
  CredentialError,
  isCredentialSource,
  isTestOnlyCredentialSource,
} from "./provider";
import type { CredentialProvider, CredentialSource } from "./provider";
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
  readonly env?: EnvCredentialProviderOptions;
  /** Passed through to the fake provider when the `fake` source is selected. */
  readonly fake?: FakeCredentialProviderOptions;
}

/**
 * Build a provider for `source`.
 *
 * @throws {CredentialError} `unknown_source` when `source` is missing or not a
 * known {@link CredentialSource}; `test_source_forbidden` when a test-only
 * source is requested without `allowTestSources`.
 */
export function createCredentialProvider(
  source: unknown,
  options: CreateCredentialProviderOptions = {},
): CredentialProvider {
  if (!isCredentialSource(source)) {
    throw new CredentialError("unknown_source", {
      source: typeof source === "string" ? source : String(source),
      reason: `expected one of ${CREDENTIAL_SOURCES.map((s) => `"${s}"`).join(", ")}; the source must be passed explicitly`,
    });
  }

  if (isTestOnlyCredentialSource(source) && options.allowTestSources !== true) {
    throw new CredentialError("test_source_forbidden", {
      source,
      reason:
        "test-only credential sources require an explicit allowTestSources opt-in",
    });
  }

  const typedSource: CredentialSource = source;

  switch (typedSource) {
    case "env":
      return createEnvCredentialProvider(options.env);
    case "fake":
      return createFakeCredentialProvider(options.fake);
    default: {
      // Exhaustiveness guard: a new source cannot be added without a branch here.
      const unreachable: never = typedSource;
      throw new CredentialError("unknown_source", {
        source: String(unreachable),
        reason: "source has no registered implementation",
      });
    }
  }
}
