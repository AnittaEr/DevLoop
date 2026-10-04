/**
 * The GitHub source plugin: the first real {@link SourcePlugin} implementation.
 *
 * It does the two things a source plugin does and nothing else. It fetches one
 * page of NATIVE items through an injected {@link HttpTransport}, and maps
 * those native items into the provider-neutral `CanonicalEvent`s core
 * understands. The credential arrives through the core credential-provider
 * contract and is handed straight to the transport; the plugin never stores
 * it, logs it, or lets it reach an error message.
 *
 * WHY THE `describe().name` IS `code_hosting`.
 *
 * The name becomes `CanonicalEvent["source"]`, which is an opaque
 * discriminator persisted alongside every event, and the acceptance criterion
 * is that it is not a provider SDK name. `"github"` would name the provider;
 * `"octokit"` would name an SDK we deliberately do not depend on. `"code_hosting"`
 * names the ROLE this source plays for DevLoop -- the same word a
 * self-hosted or differently-branded instance of the same product would also
 * truthfully be. Swapping the provider later, or running two of them, does not
 * change the name. See the plugin-boundary guard in
 * `src/core/__tests__/plugin-boundary.test.ts`, whose deny-list would flag the
 * provider's own name anywhere under `src/core/**`.
 */

import type { CredentialProvider } from "@/core/credentials/provider";
import {
  CANONICAL_EVENT_TYPES,
  type CanonicalEvent,
  type CanonicalEventType,
  type JsonObject,
  type JsonValue,
} from "@/core/events/canonical-event";
import type {
  FetchedPage,
  PluginDescriptor,
  SourcePlugin,
} from "@/core/plugins/plugin";

import {
  GITHUB_PLUGIN_ERROR_REASONS,
  GitHubPluginError,
  reasonForStatus,
  type GitHubPluginErrorCode,
  type GitHubPluginErrorReason,
} from "./github-errors";
import { isNativeIssueItem, type NativeIssueItem } from "./native-item";
import type { NativeLabel } from "./native-item";
import type { HttpTransport } from "./transport";

/**
 * Provider-neutral source discriminator. See the file header for why this is
 * not a provider name.
 */
export const SOURCE_NAME = "code_hosting";

/** Plugin implementation version, independent of the package version. */
export const PLUGIN_VERSION = "0.1.0";

/** Items requested per page. */
export const PAGE_SIZE = 30;

export interface GitHubPluginOptions {
  /**
   * The HTTP seam. Injected rather than imported so that tests exercise
   * `fetchItems` with canned JSON and no network.
   */
  readonly transport: HttpTransport;
  /** Supplies the credential. Its own errors are already secret-free. */
  readonly credentials: CredentialProvider;
  /** `owner/name` of the repository to read. */
  readonly repository: string;
  /** Defaults to {@link PAGE_SIZE}. */
  readonly pageSize?: number;
}

/**
 * Build the canonical id for an event.
 *
 * Derived from `source` + `externalId` and nothing else -- no timestamp, no
 * array position, no randomness -- so mapping the same native item twice, in
 * any order, always yields the same id. That is what makes re-ingest idempotent.
 */
export function canonicalEventId(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

/**
 * Recursively drop values JSON cannot represent.
 *
 * `undefined` is not a `JsonValue`, and `JSON.stringify` silently drops an
 * `undefined` object property while turning an `undefined` array element into
 * `null`. Rather than let those two behaviours make `metadata` non-round-trip
 * stable, undefined is stripped here: object properties with an undefined
 * value are removed, and undefined array elements are removed too. Functions
 * and `NaN`/`Infinity` are stringified so nothing silently becomes `null`.
 */
export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const entry of value) {
      const json = toJsonValue(entry);
      if (json !== undefined) out.push(json);
    }
    return out;
  }
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const json = toJsonValue(entry);
      if (json !== undefined) out[key] = json;
    }
    return out;
  }
  // Functions and symbols are not canonical metadata. Stringify rather than
  // drop, so a caller can see that something was there.
  return String(value);
}

/**
 * Build a canonical metadata bag from a partial native shape.
 *
 * Exported for its own unit test: it is a choke point, and a choke point that
 * only ever runs behind a mapper which has already applied `?? null` to every
 * field would be untested in the one way that matters.
 */
export function toMetadata(source: Record<string, unknown>): JsonObject {
  const json = toJsonValue(source);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return {};
  }
  return json;
}

/**
 * Which canonical role a native item plays.
 *
 * The discriminator is the presence of the source's own change-proposal
 * sub-object, not the word "pull request" and not anything in the core union.
 * Both output values are members of `CanonicalEventType`; the union is not
 * widened anywhere in this file.
 */
function canonicalTypeFor(item: NativeIssueItem): CanonicalEventType {
  return item.pull_request === undefined ? "issue" : "change_proposal";
}

/** The `externalId` a native item carries: `<repo>#<number>`. */
function externalIdFor(item: NativeIssueItem, repository: string): string {
  return `${repository}#${item.number}`;
}

/** A non-empty string, or `undefined`. Keeps empty provider fields off the event. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Read a `labels` array defensively at the point of use.
 *
 * `isNativeIssueItem` already rejects a non-array `labels`, so on the
 * validated path this returns its input. The narrowing is kept anyway because
 * the mapper is a public method: `mapToCanonicalEvents` takes a
 * `readonly NativeIssueItem[]` from a caller and the type is erased at
 * runtime, so an unvalidated item CAN arrive here. Calling `.map()` on
 * whatever that is would raise a raw `TypeError` quoting the offending value
 * -- an uncontrolled error path, and the exact leak class
 * `github-errors.ts` exists to prevent.
 *
 * An unusable value degrades to an empty list rather than throwing: dropping
 * one optional metadata field is strictly better than an uncontrolled failure,
 * and the canonical event's shape does not depend on the field.
 */
function labelsOf(item: NativeIssueItem): readonly unknown[] {
  const labels: unknown = item.labels;
  return Array.isArray(labels) ? labels : [];
}

/**
 * Reject a `pageSize` that cannot produce a usable page.
 *
 * A non-positive, fractional or `NaN` page size was previously accepted
 * verbatim and then used two ways that both break. It is interpolated into
 * `per_page`, so the source is asked for `0`, `-1` or `NaN` items and decides
 * what to do with a nonsense query. And it is the threshold in
 * `nextCursorFor`, where `count < this.pageSize` decides whether the page was
 * short; with a page size of `0` that comparison is never true, so EVERY page
 * looks full and pagination continues forever against a source that has no
 * more data. Silent truncation is the failure mode here, not a loud one.
 *
 * The bound is a cap rather than a fixed page size because that is what the
 * source will accept; anything above it is a caller bug worth naming.
 */
const MAX_PAGE_SIZE = 100;

function assertUsablePageSize(pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new GitHubPluginError("invalid_page_size", {
      reason: GITHUB_PLUGIN_ERROR_REASONS.pageSizeUnusable,
    });
  }
  if (pageSize > MAX_PAGE_SIZE) {
    throw new GitHubPluginError("invalid_page_size", {
      reason: GITHUB_PLUGIN_ERROR_REASONS.pageSizeTooLarge,
    });
  }
  return pageSize;
}

/**
 * Run an injected, untrusted call and replace ANY failure with a typed,
 * secret-free {@link GitHubPluginError}.
 *
 * THE POINT IS WHERE THE CALL HAPPENS. `call()` is invoked inside this
 * function's `async` body, so a synchronous `throw` from the callee is
 * converted into a rejection of this function's own promise before `catch`
 * ever sees it. Both failure modes -- synchronous throw and asynchronous
 * rejection -- therefore take the identical path, and neither can carry
 * caller-supplied text out.
 *
 * This is deliberately NOT the shape `call().catch(redact)`. A `.catch`
 * handler is attached to a promise that already exists: if `call()` throws
 * before returning that promise, nothing is left for `.catch` to attach to
 * and the original error -- credential and all -- propagates untouched. That
 * was a live defect here, not a theoretical one; see the call sites in
 * `fetchItems`.
 *
 * The original error is dropped rather than wrapped, and is never attached as
 * a `cause`: see the invariant at `github-errors.ts:5-10`.
 */
async function redactingly<T>(
  code: GitHubPluginErrorCode,
  reason: GitHubPluginErrorReason,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch {
    throw new GitHubPluginError(code, { reason });
  }
}

export class GitHubSourcePlugin implements SourcePlugin<NativeIssueItem> {
  private readonly transport: HttpTransport;
  private readonly credentials: CredentialProvider;
  private readonly repository: string;
  private readonly pageSize: number;
  /**
   * Cursors this plugin instance has handed out. A cursor is opaque to core,
   * so the only thing that makes one trustworthy is that this plugin issued
   * it; anything else is refused rather than passed to the source.
   */
  private readonly issuedCursors = new Set<string>();

  constructor(options: GitHubPluginOptions) {
    this.transport = options.transport;
    this.credentials = options.credentials;
    this.repository = options.repository;
    this.pageSize = assertUsablePageSize(options.pageSize ?? PAGE_SIZE);
  }

  describe(): PluginDescriptor {
    return {
      name: SOURCE_NAME,
      version: PLUGIN_VERSION,
      requiresAuth: true,
      authDescription:
        "A fine-grained personal access token with read access to the repository.",
    };
  }

  async fetchItems(cursor?: string): Promise<FetchedPage<NativeIssueItem>> {
    const page = this.resolveCursor(cursor);

    // WHY `redactingly`, AND WHY IT WRAPS THE CALL.
    //
    // The obvious spelling is `this.transport.request({...}).catch(redact)`,
    // and it is WRONG. `.catch` attaches a handler to an already-created
    // promise, so it runs for a REJECTION and for nothing else. A callee that
    // throws SYNCHRONOUSLY has already thrown by the time `.catch` is reached:
    // the exception unwinds past the whole expression and the redaction never
    // runs. That is a real shape for an injected seam -- a misconfigured
    // `fetchImpl`, a proxy-wrapped transport, a pre-flight validation in the
    // provider -- and it defeated the invariant `github-errors.ts` exists to
    // enforce, letting an error like `boom with token github_pat_...` escape
    // verbatim.
    //
    // Invoking the callee INSIDE an `async` function fixes it structurally
    // rather than by enumeration: an async function converts a synchronous
    // throw into a rejection of its own returned promise BEFORE any handler is
    // attached, so both failure modes take the identical path. There is no
    // ordering to get wrong and no second code path to keep in sync.
    //
    // The original error is still dropped, never wrapped or attached as a
    // `cause`: see `github-errors.ts:5-10`.
    const token = await redactingly(
      "credential_failed",
      GITHUB_PLUGIN_ERROR_REASONS.credentialUnavailable,
      () => this.credentials.getToken(),
    );

    const response = await redactingly(
      "transport_failed",
      GITHUB_PLUGIN_ERROR_REASONS.transportRejected,
      () =>
        this.transport.request({
          path: `/repos/${this.repository}/issues`,
          query: {
            per_page: String(this.pageSize),
            page: String(page),
            state: "all",
            direction: "desc",
          },
          token,
        }),
    );

    if (response.status < 200 || response.status >= 300) {
      throw new GitHubPluginError("http_status", {
        reason: reasonForStatus(response.status),
        status: response.status,
      });
    }

    const items = this.parsePage(response.body);
    if (items.length === 0) {
      // Exhausted. An empty page carries no cursor, which is how core knows
      // to stop.
      return { items: [] };
    }

    const nextCursor = this.nextCursorFor(page, items.length);
    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  mapToCanonicalEvents(raw: readonly NativeIssueItem[]): CanonicalEvent[] {
    const source = this.describe().name;
    return raw.map((item) => {
      const externalId = externalIdFor(item, this.repository);
      const event: CanonicalEvent = {
        id: canonicalEventId(source, externalId),
        source,
        externalId,
        type: canonicalTypeFor(item),
        title: item.title,
        occurredAt: item.created_at,
        metadata: toMetadata({
          native_id: item.id,
          number: item.number,
          state: item.state ?? null,
          updated_at: item.updated_at ?? null,
          closed_at: item.closed_at ?? null,
          comment_count: item.comments ?? null,
          author_login: item.user?.login ?? null,
          labels: labelsOf(item).map((label) => {
            const record = (
              typeof label === "object" && label !== null ? label : {}
            ) as Partial<NativeLabel>;
            return {
              name: typeof record.name === "string" ? record.name : "",
              color: nonEmpty(record.color) ?? null,
              description: nonEmpty(record.description) ?? null,
            };
          }),
          is_proposal: item.pull_request !== undefined,
          proposal_draft: item.pull_request?.draft ?? null,
          proposal_html_url: item.pull_request?.html_url ?? null,
        }),
      };
      const url = nonEmpty(item.html_url);
      const author = nonEmpty(item.user?.login);
      return {
        ...event,
        ...(url === undefined ? {} : { url }),
        ...(author === undefined ? {} : { author }),
      };
    });
  }

  /**
   * Turn an opaque cursor into a page number, refusing anything this plugin
   * did not issue.
   */
  private resolveCursor(cursor?: string): number {
    if (cursor === undefined) return 1;
    if (!this.issuedCursors.has(cursor)) {
      throw new GitHubPluginError("invalid_cursor", {
        reason: GITHUB_PLUGIN_ERROR_REASONS.cursorNotIssued,
      });
    }
    const page = Number.parseInt(cursor.slice(CURSOR_PREFIX.length), 10);
    if (!Number.isInteger(page) || page < 1) {
      throw new GitHubPluginError("invalid_cursor", {
        reason: GITHUB_PLUGIN_ERROR_REASONS.cursorNotIssued,
      });
    }
    return page;
  }

  /**
   * Build the cursor for the page after `page`, or `undefined` when this page
   * was short -- a short page is the last page, so there is nothing to point at.
   *
   * A full page is the ONLY case that continues. Continuing off a full final
   * page costs exactly one extra request that returns zero items, which is a
   * cheaper failure than guessing wrong about the source's total count.
   */
  private nextCursorFor(page: number, count: number): string | undefined {
    if (count < this.pageSize) return undefined;
    const cursor = `${CURSOR_PREFIX}${page + 1}`;
    this.issuedCursors.add(cursor);
    return cursor;
  }

  /** Parse a response body into validated native items. */
  private parsePage(body: string): NativeIssueItem[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new GitHubPluginError("malformed_response", {
        reason: GITHUB_PLUGIN_ERROR_REASONS.bodyNotJson,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new GitHubPluginError("malformed_response", {
        reason: GITHUB_PLUGIN_ERROR_REASONS.bodyNotArray,
      });
    }
    // One malformed item fails the page loudly rather than being silently
    // skipped: a partial page would make `externalId` numbering look complete
    // when it is not.
    if (!parsed.every(isNativeIssueItem)) {
      throw new GitHubPluginError("malformed_response", {
        reason: GITHUB_PLUGIN_ERROR_REASONS.itemShapeInvalid,
      });
    }
    return parsed;
  }
}

/** Marks a cursor as issued by this plugin; the page number follows. */
export const CURSOR_PREFIX = "page:";

/** The canonical roles this plugin can emit. Exported so tests can assert it. */
export const GITHUB_CANONICAL_TYPES: readonly CanonicalEventType[] = [
  ...CANONICAL_EVENT_TYPES.filter(
    (type) => type === "issue" || type === "change_proposal",
  ),
];
