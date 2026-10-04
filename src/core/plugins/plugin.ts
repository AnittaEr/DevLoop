/**
 * The source plugin contract: the one interface a data source implements to
 * feed DevLoop.
 *
 * The surface is deliberately minimal (60-agent-briefs.md hard rule 1; risk
 * R1a mitigations 1-3): no workflow engine, no sandboxing, no dynamic
 * loading, no provider SDK types anywhere in the signatures. A plugin's
 * private, provider-shaped types stop at its own `fetch`/`map` implementation
 * and only the neutral `CanonicalEvent` crosses back out.
 */

import type { CanonicalEvent } from "../events/canonical-event";

/** Static, self-reported facts about a plugin. No capabilities, no secrets. */
export interface PluginDescriptor {
  /**
   * Stable, provider-neutral identifier for this source. Used as
   * `CanonicalEvent["source"]`, so it must not name a provider SDK.
   */
  readonly name: string;
  /** Semver string for the plugin implementation itself. */
  readonly version: string;
  /**
   * What the plugin needs in order to fetch. Stated as data so the core can
   * ask the user for it; the core never handles the credential itself.
   */
  readonly requiresAuth: boolean;
  /** Human-readable explanation of the credential or token, when required. */
  readonly authDescription?: string;
}

/** One page of raw, plugin-owned items returned by `fetchItems`. */
export interface FetchedPage<TRaw> {
  /** The items in this page, in the plugin's own native shape. */
  readonly items: readonly TRaw[];
  /**
   * Opaque cursor for the next page, or `undefined` when the source is
   * exhausted. Treated as opaque by core -- only the plugin interprets it.
   */
  readonly nextCursor?: string;
}

/**
 * A data source that can be ingested from.
 *
 * `TRaw` is the plugin's own native item type. It appears only inside this
 * interface's method signatures, so a provider-specific type is structurally
 * confined to the plugin implementation and can never appear in a core
 * signature or a core value.
 */
export interface SourcePlugin<TRaw = unknown> {
  /** Static facts about this source. Must be free of secrets. */
  describe(): PluginDescriptor;

  /**
   * Fetch one page of native items. Returns an empty page when exhausted.
   * `cursor` is whatever a previous call returned as `nextCursor`.
   */
  fetchItems(cursor?: string): Promise<FetchedPage<TRaw>>;

  /**
   * Map native items to canonical events. Core calls this only with items
   * this plugin produced via `fetchItems`.
   */
  mapToCanonicalEvents(raw: readonly TRaw[]): CanonicalEvent[];
}

/**
 * A `SourcePlugin` with its native item type erased to `unknown` -- the shape a
 * registry can hold for plugins of different native types side by side.
 *
 * `TRaw` appears only inside the plugin's own implementation, and it is erased
 * at this boundary: core receives items as `unknown` and never inspects them,
 * it only hands them straight back to the same plugin's `mapToCanonicalEvents`.
 * Because both methods are declared with method syntax, TypeScript compares
 * their parameters bivariantly, so a `SourcePlugin<MemoItem>` is assignable
 * here without any cast at the call site.
 */
export type RegisteredPlugin = {
  describe(): PluginDescriptor;
  fetchItems(cursor?: string): Promise<FetchedPage<unknown>>;
  mapToCanonicalEvents(raw: readonly unknown[]): CanonicalEvent[];
};
