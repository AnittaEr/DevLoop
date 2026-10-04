/**
 * TEST-ONLY in-memory credential provider.
 *
 * !!! DO NOT IMPORT FROM PRODUCTION CODE !!!
 *
 * This module exists so the GitHub plugin can be built and tested end-to-end
 * before any real token exists. `createCredentialProvider` refuses the `fake`
 * source unless the caller passes an explicit opt-in, so a fixture provider can
 * never be selected by configuration, an environment variable, or a default.
 *
 * The values it returns are obviously-synthetic fixtures. Note that they ARE
 * deliberately well-formed in shape (correct prefix, material after it) so that
 * they exercise the same validation a real token would; what makes them safe is
 * that the material is hyphenated English prose, so no 20+ character
 * alphanumeric run exists and they cannot be mistaken for a real credential.
 */

import {
  CredentialError,
  TOKEN_SOURCE_REASONS,
  validateTokenShape,
} from "./provider";
import type { CredentialProvider } from "./provider";

/** Discriminant for this provider. */
export const FAKE_SOURCE = "fake" as const;

/**
 * The ONE key {@link FakeCredentialProvider.getToken} reads.
 *
 * `getToken` has no key parameter — the contract is one documented fixture,
 * not a map lookup — so the map is keyed by this single name and
 * {@link FakeCredentialProvider.setToken} takes no key either. An earlier
 * version let `setToken` accept any key while `getToken` still read
 * `tokens.valid`, so a fixture registered under any other name was silently
 * unreachable: `setToken("alt", …)` succeeded and had no effect on
 * `getToken()`. The map survives only so the constructor can copy the caller's
 * object (which is what keeps one provider from polluting another's fixtures).
 */
export const FAKE_TOKEN_KEY = "valid" as const;

export type FakeTokenKey = typeof FAKE_TOKEN_KEY;

/**
 * Synthetic fixture values.
 *
 * Each segment is deliberately short and hyphen-separated so that no string here
 * can satisfy a GitHub token pattern.
 */
export const FAKE_TOKENS = {
  [FAKE_TOKEN_KEY]: "github_pat_-not-a-real-fixture-token-1",
} as const;

export interface FakeCredentialProviderOptions {
  /**
   * In-memory token value, keyed by {@link FAKE_TOKEN_KEY}. Defaults to
   * {@link FAKE_TOKENS}. A map under any OTHER key is not a valid input: the
   * provider reads exactly one key, so there is no way for it to be reached.
   */
  readonly tokens?: Readonly<Partial<Record<FakeTokenKey, string>>>;
}

export class FakeCredentialProvider implements CredentialProvider {
  readonly source = FAKE_SOURCE;

  // Mutable per instance, but never shared: see the constructor. Partial
  // because a caller may legitimately supply an empty map, and `getToken`
  // handles the missing key — that is the `fixtureMissing` path below.
  private readonly tokens: Partial<Record<FakeTokenKey, string>>;

  constructor(options: FakeCredentialProviderOptions = {}) {
    // Copied, not aliased. `setToken` writes to this map, so holding the shared
    // exported `FAKE_TOKENS` object (or a caller-supplied one) would let one
    // provider permanently pollute the fixtures seen by every later provider in
    // the same worker — an order-dependent leak across test files, surfacing as
    // an unrelated assertion failure. Every instance owns its own map.
    this.tokens = { ...(options.tokens ?? FAKE_TOKENS) };
  }

  /**
   * Test helper: register or replace the fixture value on THIS provider only.
   *
   * Writes to this instance's own map, so the exported {@link FAKE_TOKENS} and
   * any other provider are unaffected. There is deliberately no `key`
   * parameter: {@link FAKE_TOKEN_KEY} is the only key that exists.
   */
  setToken(value: string): void {
    this.tokens[FAKE_TOKEN_KEY] = value;
  }

  async getToken(): Promise<string> {
    const value = this.tokens[FAKE_TOKEN_KEY];
    if (value === undefined) {
      throw new CredentialError("token_absent", {
        source: this.source,
        reason: TOKEN_SOURCE_REASONS.fixtureMissing,
      });
    }
    return validateTokenShape(value, this.source);
  }
}

export function createFakeCredentialProvider(
  options?: FakeCredentialProviderOptions,
): FakeCredentialProvider {
  return new FakeCredentialProvider(options);
}
