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
 * The values it returns are obviously-synthetic fixtures: they are not
 * well-formed GitHub token shapes and cannot be mistaken for a real credential.
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

  private readonly tokens: Readonly<Record<string, string>>;

  constructor(options: FakeCredentialProviderOptions = {}) {
    this.tokens = options.tokens ?? FAKE_TOKENS;
  }

  /** Test helper: register or replace a fixture value. */
  setToken(key: string, value: string): void {
    (this.tokens as Record<string, string>)[key] = value;
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
