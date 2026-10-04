/**
 * Credential provider contract for GitHub access (D-024a / D-041).
 *
 * This module is the ONE place in the codebase that answers "where does the
 * GitHub token come from". Consumers depend on {@link CredentialProvider} and
 * never on a concrete source.
 *
 * Secret hygiene rules encoded here:
 *  - A token value is NEVER placed in an error message, an error `cause`, or any
 *    other error field. Errors name the *source* that failed and a stable
 *    {@link CredentialErrorCode} only.
 *  - The returned token is validated for shape (non-empty, trimmed, expected
 *    prefix) but never logged or echoed.
 */

/**
 * Discriminant identifying where a credential is read from.
 *
 * `env` is the only production source. `fake` is test-only and is refused by the
 * factory unless the caller explicitly opts in.
 */
export const CREDENTIAL_SOURCES = ["env", "fake"] as const;

export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/** Sources that may only be used from tests. */
export const TEST_ONLY_CREDENTIAL_SOURCES = ["fake"] as const;

export type TestOnlyCredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/** The prefix every GitHub fine-grained personal access token carries. */
export const GITHUB_TOKEN_PREFIX = "github_pat_";

/** Stable, non-secret error codes. Never put a token in one of these. */
export const CREDENTIAL_ERROR_CODES = [
  /** The provider produced no value at all (or only whitespace). */
  "token_absent",
  /** A value was produced but failed shape validation (untrimmed, wrong prefix). */
  "token_malformed",
  /** The requested source is not a known {@link CredentialSource}. */
  "unknown_source",
  /** A test-only source was requested from a non-test caller. */
  "test_source_forbidden",
] as const;

export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number];

export interface CredentialErrorDetails {
  /** Which source failed, e.g. `env` or `fake`. */
  readonly source: string;
  /** Shape of the offending value, never the value itself. */
  readonly reason: string;
}

/**
 * Typed error thrown by every credential provider and by the factory.
 *
 * `message` is derived from `code`, `source` and `reason` only. There is
 * deliberately no field that can carry the secret.
 */
export class CredentialError extends Error {
  override readonly name = "CredentialError";
  readonly code: CredentialErrorCode;
  readonly source: string;
  readonly reason: string;

  constructor(code: CredentialErrorCode, details: CredentialErrorDetails) {
    super(
      `[${code}] credential source "${details.source}" failed: ${details.reason}`,
    );
    this.code = code;
    this.source = details.source;
    this.reason = details.reason;
    // Keeps `instanceof` working when the class is down-levelled.
    Object.setPrototypeOf(this, CredentialError.prototype);
  }
}

/** The single contract every GitHub credential source implements. */
export interface CredentialProvider {
  /** Discriminant for this provider. */
  readonly source: CredentialSource;
  /**
   * Resolve the GitHub token. Rejects with {@link CredentialError} on any
   * problem; never resolves to an invalid shape.
   */
  getToken(): Promise<string>;
}

export function isCredentialSource(value: unknown): value is CredentialSource {
  return (
    typeof value === "string" &&
    (CREDENTIAL_SOURCES as readonly string[]).includes(value)
  );
}

export function isTestOnlyCredentialSource(
  value: unknown,
): value is TestOnlyCredentialSource {
  return (
    typeof value === "string" &&
    (TEST_ONLY_CREDENTIAL_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Validate the shape of a raw token value.
 *
 * NOTE: this is a hand-rolled validator rather than a Zod schema. The card
 * requires Zod-shaped validation but also forbids adding a dependency and puts
 * `bun.lock` off-limits, and `zod` is not present on this base. The checks below
 * mirror what a Zod schema would express, so swapping in `zod` later is a
 * mechanical change confined to this function.
 *
 * Rejects, in order:
 *  - empty / whitespace-only            -> `token_absent`
 *  - leading or trailing whitespace     -> `token_malformed`
 *  - missing the required prefix        -> `token_malformed`
 *  - non-printable characters           -> `token_malformed`
 */
export function validateTokenShape(raw: unknown, source: string): string {
  if (typeof raw !== "string") {
    throw new CredentialError("token_absent", {
      source,
      reason: "provider returned a non-string value",
    });
  }

  if (raw.trim().length === 0) {
    throw new CredentialError("token_absent", {
      source,
      reason: "token is empty",
    });
  }

  if (raw !== raw.trim()) {
    // The reason describes the defect, never the value.
    throw new CredentialError("token_malformed", {
      source,
      reason: "token has leading or trailing whitespace",
    });
  }

  if (!raw.startsWith(GITHUB_TOKEN_PREFIX)) {
    throw new CredentialError("token_malformed", {
      source,
      reason: `token does not start with the required prefix (${GITHUB_TOKEN_PREFIX})`,
    });
  }

  if (raw.length <= GITHUB_TOKEN_PREFIX.length) {
    throw new CredentialError("token_malformed", {
      source,
      reason: "token has the required prefix but no credential material",
    });
  }

  if (/[^\x21-\x7e]/.test(raw)) {
    throw new CredentialError("token_malformed", {
      source,
      reason: "token contains non-printable or non-ASCII characters",
    });
  }

  return raw;
}
