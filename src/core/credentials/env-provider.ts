/**
 * Environment-backed credential provider.
 *
 * Reads the GitHub fine-grained PAT from a single documented environment
 * variable. The variable is read lazily inside {@link EnvCredentialProvider.getToken},
 * never at module import time, so importing this module has no side effects and
 * tests can mutate `process.env` freely.
 */

import { CredentialError, validateTokenShape } from "./provider";
import type { CredentialProvider } from "./provider";

/** The single documented environment variable. Name only — never a value. */
export const GITHUB_TOKEN_ENV_VAR = "GITHUB_FINE_GRAINED_PAT";

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
}

export class EnvCredentialProvider implements CredentialProvider {
  readonly source = "env" as const;

  private readonly readEnv: EnvReader;

  constructor(options: EnvCredentialProviderOptions = {}) {
    // Bound lazily: `process.env` is dereferenced on every getToken() call,
    // not once at module/constructor evaluation time.
    this.readEnv = options.readEnv ?? (() => process.env[GITHUB_TOKEN_ENV_VAR]);
  }

  async getToken(): Promise<string> {
    const raw = this.readEnv();

    if (raw === undefined || raw.trim().length === 0) {
      // Names the variable so the operator can fix it. The variable NAME is not
      // a secret; a token value could never appear here because there is none.
      throw new CredentialError("token_absent", {
        source: this.source,
        reason: `environment variable ${GITHUB_TOKEN_ENV_VAR} is not set`,
      });
    }

    return validateTokenShape(raw, this.source);
  }
}

export function createEnvCredentialProvider(
  options?: EnvCredentialProviderOptions,
): EnvCredentialProvider {
  return new EnvCredentialProvider(options);
}
