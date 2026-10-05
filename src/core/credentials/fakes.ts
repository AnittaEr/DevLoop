/**
 * TEST-ONLY in-memory credential provider.
 *
 * !!! DO NOT IMPORT FROM PRODUCTION CODE !!!
 *
 * This module exists so a source plugin can be built and tested end-to-end
 * before any real token exists. `createCredentialProvider` refuses the `fake`
 * source unless the caller passes an explicit opt-in, so a fixture provider can
 * never be selected by configuration, an environment variable, or a default.
 *
 * B19: the default fixture used to be one vendor's token prefix with synthetic
 * material after it, which put that vendor's token format in `src/core/` (and
 * made the fixture table itself a boundary violation once the guard could see
 * it). The default fixture is now built from whichever {@link TokenProfile} the
 * caller supplies, so it stays provider-neutral and still exercises the same
 * validation a real token would: the correct prefix, with material after it.
 *
 * What still makes the fixtures safe is that the material is hyphenated English
 * prose, so no 20+ character alphanumeric run exists and they cannot be mistaken
 * for a real credential.
 */

import {
  CredentialError,
  TOKEN_SOURCE_REASONS,
  assertValidTokenProfile,
  validateTokenShape,
} from "./provider";
import type { CredentialProvider, TokenProfile } from "./provider";

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
 * The synthetic material appended to whatever prefix the caller's profile
 * declares. Hyphenated prose, so the result has no long alphanumeric run and
 * cannot be mistaken for a real credential.
 */
const FIXTURE_MATERIAL = "not-a-real-fixture-token-1";

/**
 * Build the default fixture for a profile: the profile's own prefix plus
 * obviously-synthetic material.
 *
 * A FUNCTION rather than a constant, because the prefix is provider-supplied —
 * a module-level table would have to hard-code one vendor's format, which is
 * what B19 removes.
 */
export function fakeTokensFor(profile: TokenProfile): {
  readonly [FAKE_TOKEN_KEY]: string;
} {
  assertValidTokenProfile(profile);
  return { [FAKE_TOKEN_KEY]: `${profile.prefix}${FIXTURE_MATERIAL}` };
}

export interface FakeCredentialProviderOptions {
  /**
   * In-memory token value, keyed by {@link FAKE_TOKEN_KEY}. Defaults to
   * {@link fakeTokensFor} of the supplied profile. A map under any OTHER key is
   * not a valid input: the provider reads exactly one key, so there is no way
   * for it to be reached.
   */
  readonly tokens?: Readonly<Partial<Record<FakeTokenKey, string>>>;
  /**
   * Which provider's token shape to validate against. Required, for the same
   * reason as on {@link EnvCredentialProviderOptions.profile}: no default means
   * no vendor knowledge in `src/core/`.
   */
  readonly profile: TokenProfile;
}

export class FakeCredentialProvider implements CredentialProvider {
  readonly source = FAKE_SOURCE;

  // Mutable per instance, but never shared: see the constructor. Partial
  // because a caller may legitimately supply an empty map, and `getToken`
  // handles the missing key — that is the `fixtureMissing` path below.
  private readonly tokens: Partial<Record<FakeTokenKey, string>>;
  private readonly profile: TokenProfile;

  constructor(options: FakeCredentialProviderOptions) {
    assertValidTokenProfile(options.profile);
    this.profile = options.profile;
    // Copied, not aliased. `setToken` writes to this map, so holding a shared
    // fixture object (or a caller-supplied one) would let one provider
    // permanently pollute the fixtures seen by every later provider in the same
    // worker — an order-dependent leak across test files, surfacing as an
    // unrelated assertion failure. Every instance owns its own map.
    this.tokens = {
      ...(options.tokens ?? fakeTokensFor(options.profile)),
    };
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
    return validateTokenShape(value, this.source, this.profile);
  }
}

export function createFakeCredentialProvider(
  options: FakeCredentialProviderOptions,
): FakeCredentialProvider {
  return new FakeCredentialProvider(options);
}
