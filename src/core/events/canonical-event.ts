/**
 * The canonical event model: the single, provider-neutral shape every ingested
 * item is normalised into before the core app ever sees it.
 *
 * The plugin boundary is sacred (60-agent-briefs.md hard rule 1). Nothing in
 * this file may be named or typed after a specific provider: `source` is an
 * opaque string discriminator, `metadata` is JSON-safe and unstructured, and
 * `externalId` is an opaque provider-local identifier. A provider that needs
 * more than these fields carries the extra shape inside `metadata`, where it
 * stays on the plugin side of the boundary.
 */

/**
 * JSON-safe value: the closed set of types that can survive a round trip
 * through `JSON.parse(JSON.stringify(x))`. Anything else (functions, class
 * instances, cycles, BigInt, undefined) is not a canonical metadata value.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Provider-neutral JSON-safe bag. Used for `CanonicalEvent["metadata"]` so a
 * plugin can attach whatever the source gave it without widening this type
 * with provider knowledge.
 */
export type JsonObject = { [key: string]: JsonValue };

/**
 * The kinds of event DevLoop ingests. These are domain concepts (a unit of
 * work, a comment on one, a change proposal, ...), not API resource names --
 * they are chosen so they read the same for every source DevLoop will support.
 */
export type CanonicalEventType =
  | "issue"
  | "pull_request"
  | "issue_comment"
  | "pull_request_review"
  | "release"
  | "mention";

/** Every `CanonicalEventType` value, for runtime validation and iteration. */
export const CANONICAL_EVENT_TYPES: readonly CanonicalEventType[] = [
  "issue",
  "pull_request",
  "issue_comment",
  "pull_request_review",
  "release",
  "mention",
];

/**
 * A single ingested item, normalised.
 *
 * `id` is DevLoop's own stable identity for the event (derived from
 * `source` + `externalId`); `externalId` is the identifier the source gave
 * the item and is meaningless outside that source.
 */
export interface CanonicalEvent {
  /** DevLoop-internal stable id. */
  readonly id: string;
  /** Opaque source discriminator, e.g. the plugin's `describe().name`. */
  readonly source: string;
  /** Identifier assigned by the source. Only unique within `source`. */
  readonly externalId: string;
  readonly type: CanonicalEventType;
  readonly title: string;
  /** ISO-8601 timestamp of when the event happened at the source. */
  readonly occurredAt: string;
  /** Canonical web URL for the event, when the source exposes one. */
  readonly url?: string;
  /** Display handle of the actor who caused the event, when known. */
  readonly author?: string;
  /** Provider-supplied extra data, JSON-safe, never interpreted by core. */
  readonly metadata: JsonObject;
}

/**
 * Type guard for `CanonicalEventType`, so callers can narrow an untrusted
 * string without casting.
 */
export function isCanonicalEventType(
  value: string,
): value is CanonicalEventType {
  return (CANONICAL_EVENT_TYPES as readonly string[]).includes(value);
}
