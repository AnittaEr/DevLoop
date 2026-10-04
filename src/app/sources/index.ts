/**
 * The composition root for DevLoop's data sources.
 *
 * `src/core/plugins/registry.ts` says so itself: "the registry holds
 * already-constructed plugin instances. Wiring a concrete source into the app is
 * the composition root's job, outside `src/core/**`." This module is that job.
 * It is the ONE place where the neutral core contracts and the concrete
 * `src/plugins/github/**` implementation meet, and it is why the boundary lint
 * rule is scoped to `src/core/**` alone (see `eslint.config.mjs:52-55`).
 *
 * WHAT THIS MODULE IS NOT. It is a plain typed module: no React component, no
 * route handler, no polling, no scheduling. Presentation is a later card's
 * job, and the note on this card is explicit that a composition root carrying
 * source vocabulary in a component is scope creep.
 *
 * SECRET HYGIENE. The credential is never read, logged, echoed or accepted
 * here. The plugin is handed a {@link CredentialProvider} obtained from the
 * core factory, and that provider resolves the token lazily inside
 * `getToken()`. This module never holds a token value in a variable, a field,
 * a fixture, a log line or an error message — there is no code path here that
 * could, which is a stronger property than redacting one.
 *
 * WHY THE CONFIG COMES FROM AN ENVIRONMENT VARIABLE. The repository to read is
 * deployment configuration, not code, so `getSourceRegistry()` reads
 * {@link REPOSITORY_ENV_VAR}. It is the *name* of the variable that appears in
 * the error when it is unset; no value is ever read into this module.
 */

import type { CanonicalEvent } from "@/core/events/canonical-event";
import { createCredentialProvider } from "@/core/credentials/factory";
import type { EnvReader } from "@/core/credentials/env-provider";
import type { RegisteredPlugin } from "@/core/plugins/plugin";
import { PluginRegistry } from "@/core/plugins/registry";
import type { NewCanonicalEventRow } from "../../../db/schema";
import { canonicalEvents } from "../../../db/schema";
import { toCanonicalEventRow } from "../../../db/canonical-event-mapper";
import { getDb } from "@/lib/db/client";
import {
  GitHubSourcePlugin,
  SOURCE_NAME,
} from "@/plugins/github/github-plugin";
import type { HttpTransport } from "@/plugins/github/transport";
import { createFetchTransport } from "@/plugins/github/transport";

export { SOURCE_NAME };

/**
 * Name of the environment variable holding `owner/name` of the repository to
 * ingest. Name only — this module never reads a repository from anywhere else.
 */
export const REPOSITORY_ENV_VAR = "DEVLOOP_REPOSITORY";

/** Raised when the composition root is asked for a source it cannot build. */
export class SourceConfigurationError extends Error {
  override readonly name = "SourceConfigurationError";

  constructor(reason: SourceConfigurationReason) {
    super(reason);
    Object.setPrototypeOf(this, SourceConfigurationError.prototype);
  }
}

/**
 * Fixed reasons for {@link SourceConfigurationError}.
 *
 * A closed set of fixed strings, for the same reason
 * `src/core/credentials/provider.ts` keeps one: a throw site selects a member,
 * it never assembles a string from caller input, so no configuration value can
 * reach the message.
 */
export const SOURCE_CONFIGURATION_REASONS = {
  repositoryUnset: `${REPOSITORY_ENV_VAR} is not set, so no source can be built.`,
  unknownSource: "the requested source is not registered.",
  transportUnavailable:
    "no HTTP transport is available in this runtime, so no source can be built.",
} as const;

export type SourceConfigurationReason =
  (typeof SOURCE_CONFIGURATION_REASONS)[keyof typeof SOURCE_CONFIGURATION_REASONS];

export interface SourceRegistryOptions {
  /** `owner/name` of the repository to read. Required. */
  readonly repository: string;
  /**
   * The HTTP seam. Injected by tests; production leaves it unset and gets the
   * `fetch`-backed transport built here at the composition root.
   */
  readonly transport?: HttpTransport;
  /** Overrides the provider API root (e.g. a self-hosted instance). */
  readonly apiRoot?: string;
  /**
   * Environment reader handed to the core credential factory. Injected by tests
   * so the real `env` source can be exercised without touching `process.env`
   * and without a real token ever existing.
   */
  readonly readEnv?: EnvReader;
  /** Items requested per page. Defaults to the plugin's own default. */
  readonly pageSize?: number;
  /**
   * Further already-constructed plugins to register alongside the GitHub one.
   *
   * Exists so the registry's multi-source capability can be proved without a
   * second concrete plugin existing yet. It takes constructed instances, never
   * module paths, so adding a source is still an explicit static decision here.
   */
  readonly additionalPlugins?: readonly RegisteredPlugin[];
}

/**
 * The credential provider this composition root gives to a source plugin.
 *
 * The source is passed EXPLICITLY as `env` and there is no `fake` option, so the
 * test-only credential source that `createCredentialProvider` guards behind
 * `allowTestSources` is unreachable from this module by construction: there is
 * no parameter through which a caller could ask for it. Tests exercise this
 * same production path by injecting {@link EnvReader} instead.
 */
function credentialProviderFor(
  readEnv: EnvReader | undefined,
): ReturnType<typeof createCredentialProvider> {
  return createCredentialProvider("env", {
    ...(readEnv === undefined ? {} : { env: { readEnv } }),
  });
}

/**
 * Build a {@link PluginRegistry} holding the GitHub source plugin.
 *
 * The list is static and explicit: the registry is handed already-constructed
 * instances and never resolves a module itself, so importing this module cannot
 * pull in anything that was not already named here.
 */
export function createSourceRegistry(
  options: SourceRegistryOptions,
): PluginRegistry {
  const transport = options.transport ?? fetchTransportOrThrow(options.apiRoot);
  const github = new GitHubSourcePlugin({
    transport,
    credentials: credentialProviderFor(options.readEnv),
    repository: options.repository,
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  return new PluginRegistry([github, ...(options.additionalPlugins ?? [])]);
}

function fetchTransportOrThrow(apiRoot: string | undefined): HttpTransport {
  try {
    return createFetchTransport(apiRoot === undefined ? {} : { apiRoot });
  } catch {
    // The transport's own error names no secret (it has none), but the reason
    // is fixed here so this module's error surface stays a closed set.
    throw new SourceConfigurationError(
      SOURCE_CONFIGURATION_REASONS.transportUnavailable,
    );
  }
}

let singleton: PluginRegistry | undefined;

/**
 * The process-wide registry, built on first use from configuration.
 *
 * Lazy on purpose: building the registry constructs the `fetch` transport, and
 * a module that touched the network stack at import time would make merely
 * importing this file environment-dependent.
 *
 * Passing `options` bypasses the memo so a test can build a differently
 * configured registry without mutating the shared one.
 */
export function getSourceRegistry(
  options?: SourceRegistryOptions,
): PluginRegistry {
  if (options !== undefined) return createSourceRegistry(options);
  if (singleton !== undefined) return singleton;

  const repository = process.env[REPOSITORY_ENV_VAR];
  if (repository === undefined || repository === "") {
    throw new SourceConfigurationError(
      SOURCE_CONFIGURATION_REASONS.repositoryUnset,
    );
  }
  singleton = createSourceRegistry({ repository });
  return singleton;
}

/**
 * Resolves one plugin by name, or throws a fixed-reason error.
 *
 * `PluginRegistry.get` deliberately returns a typed result rather than throwing;
 * this is the one place that turns a miss into an exception, so callers
 * downstream of here do not each re-implement the check.
 */
export function requireSource(
  registry: PluginRegistry,
  name: string,
): RegisteredPlugin {
  const result = registry.get(name);
  if (!result.ok) {
    throw new SourceConfigurationError(
      SOURCE_CONFIGURATION_REASONS.unknownSource,
    );
  }
  return result.value;
}

/**
 * Fetch one page through a registered source and map it to canonical events.
 *
 * The plugin's native item type is erased by the registry, so the items are
 * handed straight back to the same plugin's `mapToCanonicalEvents` without this
 * module ever inspecting one. Nothing provider-shaped crosses here.
 */
export async function fetchCanonicalEvents(
  registry: PluginRegistry,
  name: string = SOURCE_NAME,
  cursor?: string,
): Promise<CanonicalEvent[]> {
  const plugin = requireSource(registry, name);
  const page = await plugin.fetchItems(cursor);
  return plugin.mapToCanonicalEvents(page.items);
}

/**
 * The narrow slice of a Drizzle database this module needs.
 *
 * Structural rather than the full `Database` type so a test can supply a
 * recording fake and assert exactly which rows would have been written. The real
 * client returned by `getDb()` satisfies it, which `bun run typecheck` pins:
 * `getDb()` is used here as the fallback target, so if the two ever diverge the
 * build turns red rather than the insert failing at run time.
 */
export interface CanonicalEventWriter {
  insert(table: typeof canonicalEvents): {
    values(rows: NewCanonicalEventRow[]): PromiseLike<unknown>;
  };
}

/**
 * Persist canonical events to the `canonical_events` table.
 *
 * Only fields the `CanonicalEvent` contract defines are written: the mapping to
 * row shape is `db/canonical-event-mapper.ts`'s job, which is the type↔storage
 * boundary and knows every column. No column is named here, so this module
 * cannot drift from the schema or invent a field.
 *
 * An empty list is a no-op rather than a query: a source that has nothing new
 * must not cost a round trip, and Drizzle rejects an empty `values()`.
 *
 * @returns how many rows were written.
 */
export async function persistCanonicalEvents(
  events: readonly CanonicalEvent[],
  writer?: CanonicalEventWriter,
): Promise<number> {
  if (events.length === 0) return 0;
  const rows = events.map(toCanonicalEventRow);
  // Resolved INSIDE the guard rather than as a default parameter value: a
  // default is evaluated on every call, including when a writer is supplied, so
  // `writer = getDb()` would demand DATABASE_URL from a caller that never
  // touches the database at all.
  await (writer ?? getDb()).insert(canonicalEvents).values(rows);
  return rows.length;
}

export interface SyncOptions {
  readonly registry: PluginRegistry;
  /** Registered plugin name. Defaults to the GitHub plugin's own name. */
  readonly source?: string;
  /** Opaque cursor from a previous call. */
  readonly cursor?: string;
  /** Persistence target. Defaults to the real Drizzle client. */
  readonly writer?: CanonicalEventWriter;
}

export interface SyncResult {
  /** The events this sync produced, in source order. */
  readonly events: CanonicalEvent[];
  /** How many rows were written. */
  readonly persisted: number;
}

/**
 * The user-facing loop this card exists to make reachable: fetch work from a
 * source, then persist the canonical events it maps to.
 */
export async function syncSource(options: SyncOptions): Promise<SyncResult> {
  const events = await fetchCanonicalEvents(
    options.registry,
    options.source ?? SOURCE_NAME,
    options.cursor,
  );
  const persisted = await persistCanonicalEvents(
    events,
    options.writer ?? getDb(),
  );
  return { events, persisted };
}
