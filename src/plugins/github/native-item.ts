/**
 * The plugin's NATIVE item type and the response shapes it parses.
 *
 * Every name in this file is GitHub's own vocabulary -- `html_url`,
 * `pull_request`, `created_at` -- because these are the shapes the source
 * actually returns. That is precisely why the file lives under
 * `src/plugins/github/**`: the plugin boundary guard in
 * `src/core/__tests__/plugin-boundary.test.ts` denies exactly this vocabulary
 * inside `src/core/**`, and permits it here. Nothing in core may import this
 * file; `src/plugins/github/__tests__/plugin-boundary.test.ts` asserts that.
 */

/** A user reference as the source returns it inside an item. */
export interface NativeUserRef {
  readonly login: string;
  readonly id: number;
  readonly type?: string;
}

/** A label as the source returns it inside an item. */
export interface NativeLabel {
  readonly name: string;
  readonly color?: string | null;
  readonly description?: string | null;
}

/**
 * The sub-object GitHub attaches to an issue that is really a change
 * proposal (a pull request). Its presence is the only signal that
 * distinguishes the two canonical roles.
 */
export interface NativeProposalRef {
  readonly url?: string;
  readonly html_url?: string | null;
  readonly draft?: boolean | null;
}

/** One native item: a repository issue, or a change proposal carried as one. */
export interface NativeIssueItem {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly state?: string;
  readonly html_url?: string;
  readonly created_at: string;
  readonly updated_at?: string;
  readonly closed_at?: string | null;
  readonly comments?: number;
  readonly labels?: readonly NativeLabel[];
  readonly user?: NativeUserRef | null;
  /** Present iff this item is a change proposal. */
  readonly pull_request?: NativeProposalRef;
}

/** Fields a parsed item must have before the plugin will map it. */
const REQUIRED_ITEM_FIELDS = ["id", "number", "title", "created_at"] as const;

/**
 * OPTIONAL fields the mapper reads, and how each must be shaped if present.
 *
 * The original guard checked only the four required fields and waved every
 * optional one through unvalidated, on the reasoning that "a source that adds
 * a field, or omits one the mapper does not need, must not fail the whole
 * page". That reasoning holds for fields the mapper does not consume, and
 * fails for the ones it does: `labels` is read with `.map()` at
 * `github-plugin.ts` in `mapToCanonicalEvents`, so an item carrying
 * `labels: {}` passed validation and then died with a raw
 * `TypeError: (item.labels ?? []).map is not a function`.
 *
 * That is the wrong failure for two reasons. It bypasses the typed-error
 * design -- a caller sees an unexpected `TypeError` rather than
 * `malformed_response`/`itemShapeInvalid` -- and a raw `TypeError` is exactly
 * the shape that carries whatever text it happens to quote, which is the same
 * leak class the error module exists to prevent.
 *
 * The rule below is therefore narrower and, deliberately, per-field: an absent
 * field or an explicit `null` is still accepted (the mapper already handles
 * both), and only a PRESENT field of the WRONG TYPE fails the page. Fields the
 * mapper never reads are deliberately not listed, so a source adding one is
 * still not a broken page.
 */

/** Every entry of a `labels` array must itself be label-shaped. */
function isNativeLabel(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  // `name` is what the mapper copies into canonical metadata, so a label
  // without a string `name` has nothing to contribute and mis-types the field
  // it fills. `color`/`description` are optional and passed through `?? null`,
  // so any type is tolerable there.
  return typeof record["name"] === "string";
}

/** `labels`, if present and not `null`, must be an array of labels. */
function isOptionalLabelList(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.every(isNativeLabel))
  );
}

/** `user`, if present and not `null`, must be an object with a string `login`. */
function isOptionalUserRef(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return typeof (value as Record<string, unknown>)["login"] === "string";
}

/** `pull_request`, if present, must be an object. Its presence is a discriminator. */
function isOptionalProposalRef(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  );
}

/**
 * The per-field shape checks, keyed by field name.
 *
 * `state`, `html_url`, `updated_at`, `closed_at` and `comments` are
 * intentionally absent: the mapper reads each through a `??` default or a
 * `nonEmpty` narrowing that already tolerates any type, so validating them
 * would reject pages this guard is supposed to tolerate.
 */
const OPTIONAL_ITEM_CHECKS: Readonly<
  Record<string, (value: unknown) => boolean>
> = {
  labels: isOptionalLabelList,
  user: isOptionalUserRef,
  pull_request: isOptionalProposalRef,
};

/**
 * Type guard for {@link NativeIssueItem}.
 *
 * Checks that every required field is present, and that every optional field
 * the mapper actually consumes has a usable type. See the note above on why
 * the second half is not optional.
 */
export function isNativeIssueItem(value: unknown): value is NativeIssueItem {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const hasRequiredFields = REQUIRED_ITEM_FIELDS.every(
    (field) => record[field] !== undefined && record[field] !== null,
  );
  if (!hasRequiredFields) return false;
  return Object.entries(OPTIONAL_ITEM_CHECKS).every(([field, check]) =>
    check(record[field]),
  );
}
