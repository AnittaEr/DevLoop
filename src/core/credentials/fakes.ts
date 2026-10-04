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

import { CredentialError, validateTokenShape } from "./provider";
import type { CredentialProvider } from "./provider";

/** Discriminant for this provider. */
export const FAKE_SOURCE = "fake" as const;

/**
 * Synthetic fixture values.
 *
 * Each segment is deliberately short and hyphen-separated so that no string here
 * can satisfy a GitHub token pattern.
 */
export const FAKE_TOKENS = {
  valid: "github_pat_-not-a-real-fixture-token-1",
  validAlt: "github_pat_-not-a-real-fixture-token-2",
} as const;

export interface FakeCredentialProviderOptions {
  /**
   * In-memory token values, keyed by an arbitrary logical name. Defaults to
   * {@link FAKE_TOKENS}.
   */
  readonly tokens?: Readonly<Record<string, string>>;
}

export class FakeCredentialProvider implements CredentialProvider {
  readonly source = FAKE_SOURCE;

  // Mutable per instance, but never shared: see the constructor.
  private readonly tokens: Record<string, string>;

  constructor(options: FakeCredentialProviderOptions = {}) {
    // Copied, not aliased. `setToken` writes to this map, so holding the shared
    // exported `FAKE_TOKENS` object (or a caller-supplied one) would let one
    // provider permanently pollute the fixtures seen by every later provider in
    // the same worker — an order-dependent leak across test files, surfacing as
    // an unrelated assertion failure. Every instance owns its own map.
    this.tokens = { ...(options.tokens ?? FAKE_TOKENS) };
  }

  /**
   * Test helper: register or replace a fixture value on THIS provider only.
   *
   * Writes to this instance's own map, so the exported {@link FAKE_TOKENS} and
   * any other provider are unaffected.
   */
  setToken(key: string, value: string): void {
    this.tokens[key] = value;
  }

  async getToken(): Promise<string> {
    const value = this.tokens.valid;
    if (value === undefined) {
      throw new CredentialError("token_absent", {
        source: this.source,
        reason: 'no fixture registered under the key "valid"',
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
