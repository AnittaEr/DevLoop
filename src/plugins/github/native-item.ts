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
 * Type guard for {@link NativeIssueItem}.
 *
 * Deliberately checks only what the mapper actually reads, and treats
 * everything else as optional: a source that adds a field, or omits one the
 * mapper does not need, must not fail the whole page.
 */
export function isNativeIssueItem(value: unknown): value is NativeIssueItem {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return REQUIRED_ITEM_FIELDS.every(
    (field) => record[field] !== undefined && record[field] !== null,
  );
}
