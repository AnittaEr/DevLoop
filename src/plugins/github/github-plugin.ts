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
} from "./github-errors";
import { isNativeIssueItem, type NativeIssueItem } from "./native-item";
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
    this.pageSize = options.pageSize ?? PAGE_SIZE;
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

    const token = await this.credentials.getToken().catch(() => {
      // Same reasoning as the transport rejection below: the credential path
      // is not trusted to hand back a secret-free message, so it is replaced
      // rather than re-thrown. `CredentialError` already is secret-free, but
      // this does not depend on that being true of every implementation.
      throw new GitHubPluginError("credential_failed", {
        reason: GITHUB_PLUGIN_ERROR_REASONS.credentialUnavailable,
      });
    });

    const response = await this.transport
      .request({
        path: `/repos/${this.repository}/issues`,
        query: {
          per_page: String(this.pageSize),
          page: String(page),
          state: "all",
          direction: "desc",
        },
        token,
      })
      .catch(() => {
        // The rejection is dropped, not wrapped: a transport that fails with
        // a token-shaped message must not be able to carry it into this
        // error, through `cause` or otherwise.
        throw new GitHubPluginError("transport_failed", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.transportRejected,
        });
      });

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
          labels: (item.labels ?? []).map((label) => ({
            name: label.name,
            color: label.color ?? null,
            description: label.description ?? null,
          })),
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
