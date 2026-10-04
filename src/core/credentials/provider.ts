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

import { z } from "zod";

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

/**
 * Derived from {@link TEST_ONLY_CREDENTIAL_SOURCES}, NOT from
 * {@link CREDENTIAL_SOURCES}.
 *
 * Deriving it from the full set would collapse to `CredentialSource` itself, and
 * `isTestOnlyCredentialSource` would then WIDEN a value instead of narrowing it —
 * the predicate would be a no-op as far as the type system is concerned, and a
 * caller who guards on it would still be handed a value that might be `env`.
 */
export type TestOnlyCredentialSource =
  (typeof TEST_ONLY_CREDENTIAL_SOURCES)[number];

/** The prefix every GitHub fine-grained personal access token carries. */
export const GITHUB_TOKEN_PREFIX = "github_pat_";

/**
 * The single documented environment variable holding the token. Name only — never a value.
 *
 * Declared here rather than in `env-provider` because {@link TOKEN_SOURCE_REASONS} needs it and
 * `env-provider` already imports this module: leaving it there would make the reason table
 * depend on a module that depends on it. `env-provider` re-exports it, so existing importers
 * of `../env-provider` are unaffected.
 */
export const GITHUB_TOKEN_ENV_VAR = "GITHUB_FINE_GRAINED_PAT";

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

/**
 * The set of source labels that may legally appear on a {@link CredentialError}.
 *
 * It is {@link CREDENTIAL_SOURCES} plus the fixed label {@link UNKNOWN_CREDENTIAL_SOURCE}. That
 * last member is the whole point: a caller that passes something unrecognised where a source
 * belongs gets `unknown`, never its own text back. Without a non-source member, a caller
 * would have no correct value to pass for "not a source", and the temptation would be to pass
 * the offending value.
 */
export const UNKNOWN_CREDENTIAL_SOURCE = "unknown" as const;

export const CREDENTIAL_ERROR_SOURCES = [
  ...CREDENTIAL_SOURCES,
  UNKNOWN_CREDENTIAL_SOURCE,
] as const;

/** A source label that is safe to store on, and interpolate into, an error. */
export type CredentialErrorSource = (typeof CREDENTIAL_ERROR_SOURCES)[number];

/**
 * Collapse an arbitrary value to a {@link CredentialErrorSource}.
 *
 * A recognised {@link CredentialSource} passes through unchanged. Anything else — including
 * a token-shaped string — becomes {@link UNKNOWN_CREDENTIAL_SOURCE}. This is the single choke
 * point that makes "no field can carry the secret" true of `source` rather than aspirational.
 */
export function toSafeCredentialSource(value: unknown): CredentialErrorSource {
  if (isCredentialSource(value)) return value;
  if (value === UNKNOWN_CREDENTIAL_SOURCE) return UNKNOWN_CREDENTIAL_SOURCE;
  return UNKNOWN_CREDENTIAL_SOURCE;
}

export interface CredentialErrorDetails {
  /** Which source failed. Constrained to {@link CredentialErrorSource} on the error. */
  readonly source: CredentialErrorSource;
  /** Shape of the offending value, never the value itself. */
  readonly reason: CredentialFailureReason;
}

/**
 * Typed error thrown by every credential provider and by the factory.
 *
 * `message` is derived from `code`, `source` and `reason` only, and BOTH of
 * those are constrained — by type and, redundantly, at runtime — so that no
 * caller-supplied text can be interpolated into the message or stored on the
 * error. There is deliberately no field that can carry the secret.
 *
 * The typed shape is preserved (`code`/`source`/`reason` stay enumerable and
 * assertable) precisely so that a caller still has a non-secret field to branch
 * on and a test still has something to assert on; the constraint is on *which
 * values* those fields may hold, not on whether they exist.
 */
export class CredentialError extends Error {
  override readonly name = "CredentialError";
  readonly code: CredentialErrorCode;
  readonly source: CredentialErrorSource;
  readonly reason: CredentialFailureReason;

  constructor(code: CredentialErrorCode, details: CredentialErrorDetails) {
    // Normalised BEFORE interpolation. Both helpers collapse any input that is
    // not an allowlisted member to a fixed label, so a caller that passes a
    // token where a source or a reason belongs cannot reach the message.
    const source = toSafeCredentialSource(details.source);
    const reason = toSafeFailureReason(details.reason);
    super(`[${code}] credential source "${source}" failed: ${reason}`);
    this.code = code;
    this.source = source;
    this.reason = reason;
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
 * The closed set of reasons a credential can be refused, each a FIXED string.
 *
 * This exists so that no failure path can construct a reason from the offending
 * value: reasons are looked up from this table by a stable key, and the value
 * itself is never passed to Zod's issue reporting, never interpolated, and
 * never stored. A new defect must mean adding a new key here, never building a
 * new string at a throw site.
 */
export const TOKEN_DEFECT_REASONS = {
  notAString: "provider returned a non-string value",
  empty: "token is empty",
  untrimmed: "token has leading or trailing whitespace",
  wrongPrefix: `token does not start with the required prefix (${GITHUB_TOKEN_PREFIX})`,
  noMaterial: "token has the required prefix but no credential material",
  nonPrintable: "token contains non-printable or non-ASCII characters",
  unknown: "token failed shape validation",
} as const;

type TokenDefectReason =
  (typeof TOKEN_DEFECT_REASONS)[keyof typeof TOKEN_DEFECT_REASONS];

/**
 * Reasons for a credential attempt failing for a reason OTHER than token shape:
 * the value was never produced, or the source is not permitted.
 *
 * Separate from {@link TOKEN_DEFECT_REASONS} because it is selected by a different kind of
 * decision — a stable error *code* rather than a Zod issue — and because mixing the two tables
 * would make it unclear which reasons are reachable from which throw site. As with the defect
 * table, a throw site selects a member; it never assembles a string.
 *
 * `envVarUnset` names the environment VARIABLE, which is public documentation, never a value.
 */
export const TOKEN_SOURCE_REASONS = {
  envVarUnset: `environment variable ${GITHUB_TOKEN_ENV_VAR} is not set`,
  fixtureMissing: 'no fixture registered under the key "valid"',
  testSourceForbidden:
    "test-only credential sources require an explicit allowTestSources opt-in",
  unknownSource: `expected one of ${CREDENTIAL_SOURCES.map((s) => `"${s}"`).join(", ")}; the source must be passed explicitly`,
  noImplementation: "source has no registered implementation",
} as const;

export type TokenSourceReason =
  (typeof TOKEN_SOURCE_REASONS)[keyof typeof TOKEN_SOURCE_REASONS];

/**
 * Every reason a {@link CredentialError} may carry, as FIXED strings.
 *
 * This is the allowlist the error constructor enforces against. It is a membership test over
 * this array, so a value that merely *looks* like a reason is still rejected.
 */
export const CREDENTIAL_FAILURE_REASONS = [
  ...Object.values(TOKEN_DEFECT_REASONS),
  ...Object.values(TOKEN_SOURCE_REASONS),
] as const;

/** A failure reason that is safe to store on, and interpolate into, an error. */
export type CredentialFailureReason =
  (typeof CREDENTIAL_FAILURE_REASONS)[number];

const SAFE_REASON_SET: ReadonlySet<string> = new Set<string>(
  CREDENTIAL_FAILURE_REASONS,
);

/**
 * Collapse an arbitrary value to a {@link CredentialFailureReason}.
 *
 * An allowlisted member passes through byte for byte. Anything else becomes the generic
 * {@link TOKEN_DEFECT_REASONS.unknown} reason. This is the choke point that makes the error's
 * "no field can carry the secret" claim true of `reason` as well as of `source`.
 */
export function toSafeFailureReason(value: unknown): CredentialFailureReason {
  if (typeof value === "string" && SAFE_REASON_SET.has(value)) {
    return value as CredentialFailureReason;
  }
  return TOKEN_DEFECT_REASONS.unknown;
}

/**
 * Presence check: is there a token at all?
 *
 * `.trim()` before `.min(1)` is what makes a whitespace-only value *absent*
 * rather than malformed. Failure here is `token_absent`.
 */
const TOKEN_PRESENCE_SCHEMA = z.string().trim().min(1, {
  // Zod's own min-message would not be in the allowlist, so a blank value would
  // be reported as the generic `unknown` reason. Overriding it keeps every
  // reason a member of the fixed table, including for the empty case.
  error: TOKEN_DEFECT_REASONS.empty,
});

/**
 * Shape check, applied only to a value already known to be non-blank.
 *
 * All four checks live in one `superRefine` so their order — and therefore the
 * reason a caller sees — is explicit rather than an artefact of how a chain of
 * refinements happens to short-circuit. Each issue carries a message taken from
 * {@link TOKEN_DEFECT_REASONS}; Zod's own `input` and `received` fields are
 * discarded and never read, because they would carry the secret.
 */
const TOKEN_SHAPE_SCHEMA = z.string().superRefine((value, ctx) => {
  if (value !== value.trim()) {
    ctx.addIssue({
      code: "custom",
      message: TOKEN_DEFECT_REASONS.untrimmed,
    });
    return;
  }

  if (!value.startsWith(GITHUB_TOKEN_PREFIX)) {
    ctx.addIssue({
      code: "custom",
      message: TOKEN_DEFECT_REASONS.wrongPrefix,
    });
    return;
  }

  if (value.length <= GITHUB_TOKEN_PREFIX.length) {
    ctx.addIssue({
      code: "custom",
      message: TOKEN_DEFECT_REASONS.noMaterial,
    });
    return;
  }

  if (/[^\x21-\x7e]/.test(value)) {
    ctx.addIssue({
      code: "custom",
      message: TOKEN_DEFECT_REASONS.nonPrintable,
    });
  }
});

/** Resolve a Zod issue message back to a known-safe fixed reason. */
function reasonFromZod(
  issues: readonly { message: string }[],
): TokenDefectReason {
  const known = new Set<string>(Object.values(TOKEN_DEFECT_REASONS));
  const match = issues
    .map((issue) => issue.message)
    .find((message) => known.has(message));
  return (
    (match as TokenDefectReason | undefined) ?? TOKEN_DEFECT_REASONS.unknown
  );
}

/**
 * Validate the shape of a raw token value with Zod, and return it unchanged.
 *
 * Rejects, in order:
 *  - non-string, empty, or whitespace-only -> `token_absent`
 *  - leading or trailing whitespace        -> `token_malformed`
 *  - missing the required prefix           -> `token_malformed`
 *  - prefix but no credential material     -> `token_malformed`
 *  - non-printable characters              -> `token_malformed`
 *
 * Secret hygiene: the offending value reaches nothing but Zod's validator, and
 * leaves only as one of the fixed {@link TOKEN_DEFECT_REASONS} strings. It is
 * not echoed into the error, not used as a Zod issue message, and not attached
 * as an error `cause`.
 *
 * `source` is normalised by {@link toSafeCredentialSource} inside the error
 * constructor, so passing an arbitrary string here is already safe — the
 * {@link CredentialErrorSource} type steers callers toward the closed set, but
 * safety does not depend on it holding at runtime.
 */
export function validateTokenShape(
  raw: unknown,
  source: CredentialErrorSource,
): string {
  if (typeof raw !== "string") {
    // Checked up front so the schema's own error type never has to describe a
    // non-string, and so `token_absent` is unambiguous.
    throw new CredentialError("token_absent", {
      source,
      reason: TOKEN_DEFECT_REASONS.notAString,
    });
  }

  const presence = TOKEN_PRESENCE_SCHEMA.safeParse(raw);
  if (!presence.success) {
    throw new CredentialError("token_absent", {
      source,
      reason: reasonFromZod(presence.error.issues),
    });
  }

  const shape = TOKEN_SHAPE_SCHEMA.safeParse(raw);
  if (!shape.success) {
    throw new CredentialError("token_malformed", {
      source,
      reason: reasonFromZod(shape.error.issues),
    });
  }

  return raw;
}
