/**
 * Static plugin registry.
 *
 * Resolution is by lookup in an explicitly-typed, explicitly-populated list
 * (60-agent-briefs.md hard rule 1; risk R1a mitigation 1): no dynamic
 * `import()`, no filesystem scanning, no dependency resolution. Core can
 * therefore never come to depend on a plugin module, let alone a provider SDK
 * module, at run time.
 *
 * The registry holds already-constructed plugin instances. Wiring a concrete
 * source into the app is the composition root's job, outside `src/core/**`.
 */

import type { RegisteredPlugin } from "./plugin";

/** The error thrown-free return type of a failed lookup. */
export type RegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RegistryError };

export type RegistryErrorCode =
  | "unknown_plugin"
  | "duplicate_plugin"
  | "invalid_plugin_name";

export interface RegistryError {
  readonly code: RegistryErrorCode;
  /** The name that was asked for or registered. */
  readonly name: string;
  /** Human-readable explanation. Never contains credentials. */
  readonly message: string;
}

/**
 * A registry over a fixed set of plugins.
 *
 * The plugin list is passed to the constructor and copied; nothing is read
 * from disk or resolved at run time. Names are the keys, so a lookup cannot
 * reach a module the list does not already contain.
 */
export class PluginRegistry {
  private readonly byName: Map<string, RegisteredPlugin>;

  constructor(plugins: readonly RegisteredPlugin[] = []) {
    this.byName = new Map();
    for (const plugin of plugins) {
      const result = this.register(plugin);
      if (!result.ok) {
        throw new RegistryLookupError(result.error);
      }
    }
  }

  /**
   * Add a plugin. Returns a typed error for an unusable name or a duplicate
   * rather than throwing, except for the constructor case above where a bad
   * static list is a programming error.
   */
  register(plugin: RegisteredPlugin): RegistryResult<RegisteredPlugin> {
    const { name } = plugin.describe();
    if (name.trim() === "") {
      return {
        ok: false,
        error: {
          code: "invalid_plugin_name",
          name,
          message: "A plugin must report a non-empty name.",
        },
      };
    }
    if (this.byName.has(name)) {
      return {
        ok: false,
        error: {
          code: "duplicate_plugin",
          name,
          message: `A plugin named "${name}" is already registered.`,
        },
      };
    }
    this.byName.set(name, plugin);
    return { ok: true, value: plugin };
  }

  /**
   * Resolve a plugin by name. Returns a typed error for an unknown name --
   * never throws and never returns undefined, so callers must handle the miss
   * explicitly.
   */
  get(name: string): RegistryResult<RegisteredPlugin> {
    const plugin = this.byName.get(name);
    if (plugin === undefined) {
      return {
        ok: false,
        error: {
          code: "unknown_plugin",
          name,
          message: `No plugin is registered under the name "${name}". Registered: ${
            this.names().join(", ") || "(none)"
          }.`,
        },
      };
    }
    return { ok: true, value: plugin };
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Registered names, in registration order. */
  names(): readonly string[] {
    return [...this.byName.keys()];
  }

  /** All registered plugins, in registration order. */
  list(): readonly RegisteredPlugin[] {
    return [...this.byName.values()];
  }

  get size(): number {
    return this.byName.size;
  }
}

/** Wraps a `RegistryError` for the programming-error paths only. */
export class RegistryLookupError extends Error {
  readonly code: RegistryErrorCode;
  readonly pluginName: string;

  constructor(error: RegistryError) {
    super(error.message);
    this.name = "RegistryLookupError";
    this.code = error.code;
    this.pluginName = error.name;
  }
}
