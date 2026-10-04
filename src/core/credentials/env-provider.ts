/**
 * Environment-backed credential provider.
 *
 * Reads a provider's access token from the single environment variable named by
 * the injected {@link TokenProfile}. The variable is read lazily inside
 * {@link EnvCredentialProvider.getToken}, never at module import time, so
 * importing this module has no side effects and tests can mutate `process.env`
 * freely.
 *
 * B19: the variable NAME is no longer known here. It arrives on the profile, so
 * this module stays provider-agnostic even though its whole job is to read one
 * specific provider's token.
 */

import {
  CredentialError,
  TOKEN_SOURCE_REASONS,
  assertValidTokenProfile,
  validateTokenShape,
} from "./provider";
import type { CredentialProvider, TokenProfile } from "./provider";

/**
 * Minimal shape of the environment reader. Injecting it keeps the provider
 * testable without touching `process.env` at all.
 */
export type EnvReader = () => string | undefined;

export interface EnvCredentialProviderOptions {
  /**
   * Environment reader. Defaults to reading `process.env` lazily at call time.
   */
  readonly readEnv?: EnvReader;
  /**
   * Which provider's token to read, and from which variable.
   *
   * Required — there is deliberately no default profile, because any default
   * would be one vendor's prefix and variable name living in `src/core/`
   * (B19). Supplying one is how a caller says which provider this is for.
   */
  readonly profile: TokenProfile;
}

export class EnvCredentialProvider implements CredentialProvider {
  readonly source = "env" as const;

  private readonly readEnv: EnvReader;
  private readonly profile: TokenProfile;

  constructor(options: EnvCredentialProviderOptions) {
    // Validated once here as well as inside validateTokenShape: a blank profile
    // should fail where it is supplied, not on the first token fetch.
    assertValidTokenProfile(options.profile);
    // Bound lazily: `process.env` is dereferenced on every getToken() call,
    // not once at module/constructor evaluation time.
    this.readEnv =
      options.readEnv ?? (() => process.env[options.profile.envVar]);
    this.profile = options.profile;
  }

  async getToken(): Promise<string> {
    const raw = this.readEnv();

    if (raw === undefined) {
      // Genuinely absent. This is the only case that can be reported as "not
      // set", because it is the only case where the variable has no value at
      // all.
      //
      // The reason is a FIXED string that does not name the variable: the name
      // is provider-specific and provider-supplied, and interpolating it would
      // put an unbounded value into a closed allowlist of reasons (see
      // TOKEN_SOURCE_REASONS in ./provider). A token value could never appear
      // here either, because there is none.
      throw new CredentialError("token_absent", {
        source: this.source,
        reason: TOKEN_SOURCE_REASONS.envVarUnset,
      });
    }

    // Present but blank (`""`, `"   "`, `"\t\n"`). Deliberately NOT folded
    // into the branch above: the variable IS set, and reporting it as "not
    // set" sends the operator to look for a missing export when the real fault
    // is a stray space or an empty value committed to a `.env`. `validateTokenShape`
    // classifies whitespace-only as absent with a reason that says exactly that.
    return validateTokenShape(raw, this.source, this.profile);
  }
}

export function createEnvCredentialProvider(
  options: EnvCredentialProviderOptions,
): EnvCredentialProvider {
  return new EnvCredentialProvider(options);
}
