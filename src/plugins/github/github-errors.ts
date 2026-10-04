/**
 * Typed, secret-free failures for the GitHub plugin.
 *
 * The rule this file exists to make true: **no failure path can put the
 * credential, or any other caller-supplied text, into the error**. `message` is
 * assembled from a stable `code`, a fixed `reason` and a numeric HTTP status
 * only. The underlying transport rejection is deliberately NOT attached, not as
 * a message and not as a `cause`, because a transport that fails with
 * `new Error("bad token github_pat_...")` is the realistic case this defends
 * against.
 *
 * Mirrors the pattern already established in
 * `src/core/credentials/provider.ts`, and stays on the plugin side of the
 * boundary: core never imports this.
 */

/** Stable, non-secret failure codes. */
export const GITHUB_PLUGIN_ERROR_CODES = [
  /** The transport itself rejected. */
  "transport_failed",
  /** The source answered with a non-2xx status. */
  "http_status",
  /** The body was not the JSON array shape the plugin expects. */
  "malformed_response",
  /** The pagination cursor handed to `fetchItems` is not one this plugin issued. */
  "invalid_cursor",
  /** The source answered with no usable credential. */
  "credential_failed",
  /** The requested page size cannot produce a usable page. */
  "invalid_page_size",
] as const;

export type GitHubPluginErrorCode = (typeof GITHUB_PLUGIN_ERROR_CODES)[number];

/**
 * The closed set of reasons, each a FIXED string.
 *
 * A throw site selects a member. It never assembles a string, so there is no
 * code path on which arbitrary text can reach a reason.
 */
export const GITHUB_PLUGIN_ERROR_REASONS = {
  transportRejected: "the HTTP transport rejected the request",
  unauthorised: "the source rejected the presented credential",
  forbidden: "the credential lacks access to the requested resource",
  notFound: "the requested resource does not exist or is not visible",
  rateLimited: "the source rate-limited the request",
  serverError: "the source reported a server-side failure",
  unexpectedStatus: "the source returned an unexpected status",
  bodyNotJson: "the response body was not valid JSON",
  bodyNotArray: "the response body was not the expected array of items",
  itemShapeInvalid: "a response item did not match the expected shape",
  cursorNotIssued: "the pagination cursor was not issued by this plugin",
  credentialUnavailable: "the credential provider did not yield a usable token",
  pageSizeUnusable: "the requested page size is not a positive whole number",
  pageSizeTooLarge: "the requested page size exceeds the source maximum",
  unknownReason: "an unspecified failure reason was supplied",
} as const;

export type GitHubPluginErrorReason =
  (typeof GITHUB_PLUGIN_ERROR_REASONS)[keyof typeof GITHUB_PLUGIN_ERROR_REASONS];

const SAFE_REASON_SET: ReadonlySet<string> = new Set(
  Object.values(GITHUB_PLUGIN_ERROR_REASONS),
);

/**
 * Collapse arbitrary input to a fixed reason.
 *
 * This is the choke point that makes the no-secret claim true of `reason`
 * rather than aspirational: a caller that passes a token where a reason
 * belongs gets the generic unknown reason back, never its own text.
 *
 * The fallback was `bodyNotJson`, which is a real defect and not a matter of
 * taste. `bodyNotJson` says "the response body was not valid JSON", so a
 * rejection reason that fell through here would REPORT A MALFORMED RESPONSE
 * for a failure that had no response at all -- an operator reading the log
 * would go looking for a bad payload from the source when the actual cause
 * was on our side of the seam. It also contradicted this function's own
 * documentation, which promises the "generic unknown reason" and there was no
 * such reason in the set. Hence `unknownReason`.
 *
 * The value is fixed and secret-free either way, so this change narrows a
 * misleading diagnostic; it does not weaken the redaction.
 */
export function toSafePluginReason(value: unknown): GitHubPluginErrorReason {
  if (typeof value === "string" && SAFE_REASON_SET.has(value)) {
    return value as GitHubPluginErrorReason;
  }
  return GITHUB_PLUGIN_ERROR_REASONS.unknownReason;
}

export interface GitHubPluginErrorDetails {
  readonly reason: GitHubPluginErrorReason;
  /** HTTP status, when the failure came from a response rather than a rejection. */
  readonly status?: number;
}

/**
 * The single error type every failing path in this plugin raises.
 *
 * `message`, `code`, `reason` and `status` are the whole surface. There is no
 * field that can carry a secret, which is a structural property rather than a
 * promise about how careful each call site is.
 */
export class GitHubPluginError extends Error {
  override readonly name = "GitHubPluginError";
  readonly code: GitHubPluginErrorCode;
  readonly reason: GitHubPluginErrorReason;
  readonly status?: number;

  constructor(code: GitHubPluginErrorCode, details: GitHubPluginErrorDetails) {
    const reason = toSafePluginReason(details.reason);
    const status =
      typeof details.status === "number" && Number.isInteger(details.status)
        ? details.status
        : undefined;
    super(
      status === undefined
        ? `[${code}] github source plugin failed: ${reason}`
        : `[${code}] github source plugin failed (status ${status}): ${reason}`,
    );
    this.code = code;
    this.reason = reason;
    this.status = status;
    Object.setPrototypeOf(this, GitHubPluginError.prototype);
  }
}

/** Map an HTTP status onto a fixed reason. Anything unlisted is generic. */
export function reasonForStatus(status: number): GitHubPluginErrorReason {
  switch (status) {
    case 401:
      return GITHUB_PLUGIN_ERROR_REASONS.unauthorised;
    case 403:
      return GITHUB_PLUGIN_ERROR_REASONS.forbidden;
    case 404:
      return GITHUB_PLUGIN_ERROR_REASONS.notFound;
    case 429:
      return GITHUB_PLUGIN_ERROR_REASONS.rateLimited;
    default:
      if (status >= 500) return GITHUB_PLUGIN_ERROR_REASONS.serverError;
      return GITHUB_PLUGIN_ERROR_REASONS.unexpectedStatus;
  }
}
