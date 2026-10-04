import { describe, expect, it } from "vitest";

import type { CanonicalEvent } from "../../events/canonical-event";
import type { FetchedPage, PluginDescriptor, SourcePlugin } from "../plugin";
import {
  PluginRegistry,
  RegistryLookupError,
  type RegistryResult,
} from "../registry";

/**
 * A fake, fully in-memory source with its own invented vocabulary. It exists to
 * prove the `SourcePlugin` contract is satisfiable generically -- no provider
 * module, no provider SDK, no provider-shaped type anywhere in this file
 * (risk R1 mitigation 4).
 */

interface MemoItem {
  readonly key: string;
  readonly label: string;
  readonly stamp: string;
  readonly href?: string;
  readonly byline?: string;
}

const MEMO_PAGES = {
  first: [
    {
      key: "m-1",
      label: "Draft the agenda",
      stamp: "2026-10-01T09:00:00.000Z",
      href: "https://example.invalid/memo/1",
      byline: "writer",
    },
    {
      key: "m-2",
      label: "Archive old notes",
      stamp: "2026-10-02T11:30:00.000Z",
    },
  ],
  second: [
    {
      key: "m-3",
      label: "Review the ledger",
      stamp: "2026-10-03T16:45:00.000Z",
      byline: "auditor",
    },
  ],
} as const satisfies Record<string, readonly MemoItem[]>;

const CURSOR_TO_PAGE: Record<string, "first" | "second"> = {
  "cursor-1": "second",
};

class MemoPlugin implements SourcePlugin<MemoItem> {
  describe(): PluginDescriptor {
    return {
      name: "memo-book",
      version: "0.1.0",
      requiresAuth: false,
    };
  }

  async fetchItems(cursor?: string): Promise<FetchedPage<MemoItem>> {
    const pageKey: "first" | "second" | undefined =
      cursor === undefined ? "first" : CURSOR_TO_PAGE[cursor];
    if (pageKey === undefined) {
      return { items: [] };
    }
    const nextCursor = pageKey === "first" ? "cursor-1" : undefined;
    return {
      items: MEMO_PAGES[pageKey],
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  mapToCanonicalEvents(raw: readonly MemoItem[]): CanonicalEvent[] {
    return raw.map((item) => ({
      id: `memo-book:${item.key}`,
      source: this.describe().name,
      externalId: item.key,
      type: "issue",
      title: item.label,
      occurredAt: item.stamp,
      metadata: {},
      ...(item.href === undefined ? {} : { url: item.href }),
      ...(item.byline === undefined ? {} : { author: item.byline }),
    }));
  }
}

/** A second instance of the same plugin shape, to exercise the registry. */
function makeMemoPlugin(name = "memo-book"): SourcePlugin<MemoItem> {
  return {
    describe: () => ({
      name,
      version: "0.1.0",
      requiresAuth: false,
    }),
    fetchItems: () => Promise.resolve({ items: [] }),
    mapToCanonicalEvents: () => [],
  };
}

function isOk<T>(result: RegistryResult<T>): result is { ok: true; value: T } {
  return result.ok;
}

function isErr<T>(result: RegistryResult<T>): result is {
  ok: false;
  error: Extract<RegistryResult<T>, { ok: false }>["error"];
} {
  return !result.ok;
}

describe("SourcePlugin contract (fake in-memory plugin)", () => {
  const plugin = new MemoPlugin();

  it("reports a provider-neutral descriptor", () => {
    expect(plugin.describe()).toEqual({
      name: "memo-book",
      version: "0.1.0",
      requiresAuth: false,
    });
  });

  it("paginates and reports an opaque cursor", async () => {
    const first = await plugin.fetchItems();
    expect(first.items.map((i) => i.key)).toEqual(["m-1", "m-2"]);
    expect(first.nextCursor).toBe("cursor-1");

    const second = await plugin.fetchItems(first.nextCursor);
    expect(second.items.map((i) => i.key)).toEqual(["m-3"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("starts from the first page when no cursor is given", async () => {
    const first = await plugin.fetchItems();
    expect(first.items.map((i) => i.key)).toEqual(["m-1", "m-2"]);
  });

  it("returns an empty page for an unknown or stale cursor", async () => {
    const unknown = await plugin.fetchItems("not-a-cursor");
    expect(unknown.items).toEqual([]);
    expect(unknown.nextCursor).toBeUndefined();

    // A stale cursor from a previous run must not resurrect a page.
    const stale = await plugin.fetchItems("cursor-from-yesterday");
    expect(stale.items).toEqual([]);
  });

  it("maps native items to canonical events, dropping absent optionals", async () => {
    const page = await plugin.fetchItems();
    const events = plugin.mapToCanonicalEvents(page.items);

    // Compare the whole array rather than indexing: the second element is the
    // interesting one (no href, no byline), and an indexed access would be
    // `| undefined` under noUncheckedIndexedAccess.
    expect(events).toEqual([
      {
        id: "memo-book:m-1",
        source: "memo-book",
        externalId: "m-1",
        type: "issue",
        title: "Draft the agenda",
        occurredAt: "2026-10-01T09:00:00.000Z",
        url: "https://example.invalid/memo/1",
        author: "writer",
        metadata: {},
      },
      {
        id: "memo-book:m-2",
        source: "memo-book",
        externalId: "m-2",
        type: "issue",
        title: "Archive old notes",
        occurredAt: "2026-10-02T11:30:00.000Z",
        metadata: {},
      },
    ]);

    // Optional keys must be absent, not present-and-undefined, so a serialised
    // event stays byte-stable.
    const withoutOptionals = events.find((e) => e.externalId === "m-2");
    expect(withoutOptionals).toBeDefined();
    expect(Object.hasOwn(withoutOptionals ?? {}, "url")).toBe(false);
    expect(Object.hasOwn(withoutOptionals ?? {}, "author")).toBe(false);
  });

  it("maps an empty page to an empty event list", () => {
    expect(plugin.mapToCanonicalEvents([])).toEqual([]);
  });
});

describe("PluginRegistry", () => {
  it("resolves a registered plugin by name", () => {
    const registry = new PluginRegistry([new MemoPlugin()]);

    const found = registry.get("memo-book");
    expect(isOk(found)).toBe(true);
    if (!isOk(found)) return;
    expect(found.value.describe().name).toBe("memo-book");
    expect(registry.has("memo-book")).toBe(true);
    expect(registry.size).toBe(1);
  });

  it("returns a typed error for an unknown plugin instead of throwing", () => {
    const registry = new PluginRegistry([new MemoPlugin()]);

    const result = registry.get("no-such-source");
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("unknown_plugin");
    expect(result.error.name).toBe("no-such-source");
    expect(result.error.message).toContain("no-such-source");
    expect(result.error.message).toContain("memo-book");
  });

  it("reports a typed error for a duplicate registration", () => {
    const registry = new PluginRegistry();
    expect(registry.register(makeMemoPlugin()).ok).toBe(true);

    const second = registry.register(makeMemoPlugin());
    expect(isErr(second)).toBe(true);
    if (!isErr(second)) return;
    expect(second.error.code).toBe("duplicate_plugin");
    expect(registry.size).toBe(1);
  });

  it("reports a typed error for a blank plugin name", () => {
    const registry = new PluginRegistry();
    const result = registry.register(makeMemoPlugin("   "));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("invalid_plugin_name");
    expect(registry.size).toBe(0);
  });

  it("rejects a bad static list at construction, since that is a wiring bug", () => {
    expect(
      () => new PluginRegistry([makeMemoPlugin(), makeMemoPlugin()]),
    ).toThrow(RegistryLookupError);
  });

  it("is empty and lists names in registration order", () => {
    const empty = new PluginRegistry();
    expect(empty.size).toBe(0);
    expect(empty.names()).toEqual([]);
    expect(empty.list()).toEqual([]);
    expect(empty.get("memo-book").ok).toBe(false);

    const registry = new PluginRegistry([
      makeMemoPlugin("alpha"),
      makeMemoPlugin("beta"),
    ]);
    expect(registry.names()).toEqual(["alpha", "beta"]);
    expect(registry.list().map((p) => p.describe().name)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("accepts a plugin registered after construction", () => {
    const registry = new PluginRegistry([makeMemoPlugin("alpha")]);
    expect(registry.register(makeMemoPlugin("gamma")).ok).toBe(true);
    expect(registry.names()).toEqual(["alpha", "gamma"]);
  });
});
